// portfox - system interaction: who holds a port, process details, signals.
// Strategy: lsof -> ss -> netstat (macOS/Linux), netstat + tasklist (Windows).
// Zero dependencies by design.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseEtime } from "./ui.js";

const pExecFile = promisify(execFile);
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

async function run(cmd, args) {
  try {
    const { stdout } = await pExecFile(cmd, args, {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    // lsof exits 1 for an empty selection. Keep that distinct from a failed,
    // timed-out or truncated scan; callers decide whether emptiness is valid.
    return {
      ok: false,
      emptySelection: err?.code === 1 && !err.killed && !err.signal &&
        err.stdout === "" && err.stderr === "",
      stdout: "",
    };
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- parsing -------------------------------- */
// Exported for tests.

export function portFromSocketName(name) {
  let value = String(name);
  const arrow = value.indexOf("->");
  if (arrow !== -1) value = value.slice(0, arrow);
  const port = Number(value.slice(value.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// `lsof -Fpcn` field output.
export function parseLsofFieldOutput(stdout) {
  const entries = [];
  let current = null;
  for (const line of String(stdout).split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      current = { pid: Number(value), name: null, sockets: [] };
      entries.push(current);
    } else if (tag === "c" && current) current.name = value;
    else if (tag === "n" && current) current.sockets.push(value);
  }
  return entries;
}

// `ss -ltnpH` output (Linux).
export function parseSsOutput(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LISTEN")) continue;
    const cols = trimmed.split(/\s+/);
    const address = cols[3];
    const port = address ? portFromSocketName(address) : null;
    if (!port) continue;
    const userPart = trimmed.slice(trimmed.indexOf("users:("));
    const re = /\("([^"]+)",pid=(\d+)/g;
    let m;
    let found = false;
    if (userPart !== "") {
      while ((m = re.exec(userPart))) {
        found = true;
        rows.push({ pid: Number(m[2]), name: m[1], port, address });
      }
    }
    if (!found) rows.push({ pid: null, name: null, port, address });
  }
  return rows;
}

// `netstat -ltnp` (Linux with pids) or `netstat -ltn` (BSD/macOS, no pids).
export function parseNetstatUnix(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^tcp6?$/.test(cols[0])) continue;
    if ("LISTEN" !== cols[5]) continue;
    const address = cols[3];
    const port = portFromSocketName(address);
    if (!port) continue;
    const proc = (cols[6] || "").split("/");
    const pid = Number(proc[0]);
    rows.push({
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      name: proc[1] || null,
      port,
      address,
    });
  }
  return rows;
}

// `netstat -ano -p tcp` (Windows), then tasklist adds the names.
export function parseNetstatWindows(stdout) {
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const port = portFromSocketName(cols[1]);
    const pid = Number(cols[4]);
    if (port && Number.isInteger(pid)) rows.push({ pid, name: null, port, address: cols[1] });
  }
  return rows;
}

// One listener per PID, but addresses stay mapped to the port they belong to,
// so listings never show a socket of a different port on the same PID.
export function listenersFromRows(rows) {
  const listeners = [];
  const byPid = new Map();
  for (const row of rows) {
    if (row.pid == null) {
      listeners.push({
        pid: null,
        name: row.name,
        addresses: row.address ? [row.address] : [],
        portAddresses: { [row.port]: row.address ? [row.address] : [] },
        ports: [row.port],
      });
      continue;
    }
    let entry = byPid.get(row.pid);
    if (!entry) {
      entry = { pid: row.pid, name: null, addresses: [], portAddresses: {}, ports: [] };
      byPid.set(row.pid, entry);
      listeners.push(entry);
    }
    if (!entry.name && row.name) entry.name = row.name;
    if (row.address && !entry.addresses.includes(row.address)) entry.addresses.push(row.address);
    if (entry.portAddresses[row.port] === undefined) {
      entry.portAddresses[row.port] = [];
      entry.ports.push(row.port);
    }
    if (row.address && !entry.portAddresses[row.port].includes(row.address)) entry.portAddresses[row.port].push(row.address);
  }
  return listeners;
}

export function listenersFromLsof(stdout, filterPort) {
  return parseLsofFieldOutput(stdout)
    .map((e) => ({
      pid: e.pid,
      name: e.name,
      sockets: filterPort ? e.sockets.filter((s) => portFromSocketName(s) === filterPort) : e.sockets.slice(),
    }))
    .filter((e) => e.sockets.length > 0)
    .map((e) => {
      const portAddresses = {};
      for (const socket of e.sockets) {
        const port = portFromSocketName(socket);
        if (!port) continue;
        if (portAddresses[port] === undefined) portAddresses[port] = [];
        portAddresses[port].push(socket);
      }
      return {
        pid: e.pid,
        name: e.name,
        addresses: e.sockets.slice(),
        portAddresses,
        ports: Object.keys(portAddresses).map(Number),
      };
    });
}

/* -------------------------------- discovery ------------------------------- */

async function windowsTaskNames(pids) {
  const names = new Map();
  await Promise.all(
    pids.map(async (pid) => {
      const res = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const m = res.ok && res.stdout.match(/^"([^"]+)"/m);
      if (m) names.set(pid, m[1].replace(/\.exe$/i, ""));
    })
  );
  return names;
}

async function windowsListening(port) {
  const res = await run("netstat", ["-ano", "-p", "tcp"]);
  if (!res.ok) throw scanError();
  let rows = parseNetstatWindows(res.stdout);
  if (port) rows = rows.filter((r) => r.port === port);
  const names = await windowsTaskNames([...new Set(rows.map((r) => r.pid))]);
  return rows.map((r) => ({ ...r, name: names.get(r.pid) || r.name }));
}

export async function findListeners(port) {
  if (isWin) return listenersFromRows(await windowsListening(port));
  const lsof = await run("lsof", ["-nP", "-w", port ? `-iTCP:${port}` : "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  if (lsof.ok || lsof.emptySelection) return listenersFromLsof(lsof.stdout, port);
  // ss and netstat -ltnp use Linux formats; BSD netstat is not a substitute.
  if (!isMac) {
    const ss = await run("ss", ["-ltnpH"]);
    if (ss.ok) return listenersFromRows(parseSsOutput(ss.stdout).filter((r) => !port || r.port === port));
    const ns = await run("netstat", ["-ltnp"]);
    if (ns.ok) return listenersFromRows(parseNetstatUnix(ns.stdout).filter((r) => !port || r.port === port));
  }
  throw scanError();
}

export async function listListeners() {
  return findListeners();
}

function scanError() {
  return Object.assign(new Error(
    isWin ? "Unable to scan listening ports. Check that netstat is available and permitted."
      : `Unable to scan listening ports. Check that ${isMac ? "lsof is" : "lsof, ss or netstat is"} installed and permitted.`
  ), { code: "PORT_SCAN_FAILED" });
}

async function findAllSockets(port) {
  if (isWin) return [];
  const lsof = await run("lsof", ["-nP", "-w", `-iTCP:${port}`, "-Fpcn"]);
  return lsof.ok ? listenersFromLsof(lsof.stdout, port) : [];
}

// Probe both stacks: IPv4 first, then IPv6, so listeners bound only to ::1
// or to a v6-only wildcard are seen too. Machines without IPv6 simply report
// those address families as unavailable and are skipped.
const PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"];

function classifyBindError(err) {
  switch (err && err.code) {
    case "EADDRINUSE":
      return "in-use";
    case "EACCES":
    case "EPERM":
      return "denied";
    case "EADDRNOTAVAIL":
    case "EAFNOSUPPORT":
    case "ENETUNREACH":
    case "EPROTONOSUPPORT":
      return "unavailable";
    default:
      return "error";
  }
}

// "free" | "in-use" | "denied" | "unavailable" | "error".
// Only EADDRINUSE proves the port is taken; an address that cannot be bound
// at all (EADDRNOTAVAIL, no IPv6, ...) says nothing about the port.
export function bindTest(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => resolve(classifyBindError(err)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve("free")));
  });
}

export async function probePort(port) {
  let denied = false;
  let bound = false;
  for (const host of PROBE_HOSTS) {
    const res = await bindTest(port, host);
    if (res === "in-use") return "in-use";
    if (res === "free") bound = true;
    else if (res === "denied") denied = true;
    // "unavailable"/"error" for one address family: keep checking the others.
  }
  if (bound) return "free";
  if (denied) return "denied";
  return "unknown";
}

export async function inspectPort(port) {
  const listeners = await findListeners(port);
  if (listeners.length) return { occupied: true, reason: "listen", listeners };
  const probe = await probePort(port);
  if (probe === "free") return { occupied: false, reason: null, listeners: [] };
  if (probe === "denied") return { occupied: true, reason: "denied", listeners: [] };
  return { occupied: true, reason: "socket", listeners: await findAllSockets(port) };
}

// Safety net before signaling: a PID is only a target while it still listens on
// the port. Gone PIDs (or a recycled PID that no longer holds the port) are
// reported instead of killed.
export async function revalidateTargets(port, pids) {
  const fresh = await findListeners(port);
  const freshPids = new Set(fresh.filter((l) => l.pid != null).map((l) => l.pid));
  return {
    alive: pids.filter((pid) => freshPids.has(pid)),
    vanished: pids.filter((pid) => !freshPids.has(pid)),
    fresh,
  };
}

// Other ports the same PIDs listen on, so the kill prompt can warn that
// stopping the process closes those too.
export async function otherPortsForPids(pids, excludePort) {
  if (!pids.length) return [];
  const all = await listListeners();
  const ports = new Set();
  for (const listener of all) {
    if (listener.pid == null || !pids.includes(listener.pid)) continue;
    for (const p of listener.ports) if (p !== excludePort) ports.add(p);
  }
  return [...ports].sort((a, b) => a - b);
}

export async function findAvailablePorts(start, count = 1, maxScan = 1000) {
  const found = [];
  const limit = Math.min(65535, start + maxScan);
  for (let port = Math.max(1, start); port <= limit && found.length < count; port++) {
    if ((await probePort(port)) === "free") found.push(port);
  }
  return found;
}

/* ------------------------------ process info ------------------------------ */

export function commandName(command) {
  if (!command) return null;
  const first = command.trim().replace(/^"/, "").split(/\s+/)[0].replace(/"$/, "");
  let base = path.basename(first);
  return base.replace(/\.exe$/i, "") || null;
}

async function processCwd(pid) {
  if (isWin) return null;
  if (!isMac) {
    try {
      return (await fs.readlink(`/proc/${pid}/cwd`)).replace(/ \(deleted\)$/, "");
    } catch {
      return null;
    }
  }
  const res = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn", "-w"]);
  if (!res.ok) return null;
  const line = res.stdout.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

export async function getProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let info = null;

  if (isWin) {
    const res = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const m = res.ok && res.stdout.match(/^"([^"]+)","(\d+)"/m);
    if (!m) return null;
    info = { pid: Number(m[2]), ppid: null, user: null, command: m[1], name: m[1].replace(/\.exe$/i, ""), elapsedMs: null };
  } else {
    const res = await run("ps", ["-o", "pid=,ppid=,user=,etime=,command=", "-p", String(pid)]);
    const line = res.stdout.split("\n")[0];
    const m = line && line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]*)$/);
    if (!m) return null;
    info = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      elapsedMs: parseEtime(m[4]),
      command: m[5].trim(),
      name: commandName(m[5]),
    };
  }

  info.cwd = await processCwd(pid);
  info.startedAt = info.elapsedMs != null ? new Date(Date.now() - info.elapsedMs) : null;
  if (!isWin && info.ppid > 1) {
    const res = await run("ps", ["-o", "command=", "-p", String(info.ppid)]);
    const cmd = res.stdout.trim();
    if (cmd) info.parentName = commandName(cmd);
  }
  return info;
}

/* --------------------------------- signals -------------------------------- */

export function sendSignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    const code = err && err.code;
    return { ok: false, reason: code === "ESRCH" ? "gone" : code === "EPERM" ? "eperm" : String(code || err) };
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

export async function waitForAllExit(pids, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (!pids.some(isAlive)) return true;
    if (Date.now() >= deadline) return false;
    await delay(120);
  }
}

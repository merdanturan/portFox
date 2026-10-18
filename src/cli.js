// portfox - argument parsing and command flows.
import fs from "node:fs";
import * as ui from "./ui.js";
import {
  findAvailablePorts,
  getProcessInfo,
  inspectPort,
  listListeners,
  otherPortsForPids,
  probePort,
  revalidateTargets,
  sendSignal,
  waitForAllExit,
} from "./ports.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const MENU = ["Stop process", "View process details", "Find available port", "Cancel"];
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

export async function main(argv) {
  const opts = { json: false, force: false, yes: false, color: null };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--json" || arg === "-j") opts.json = true;
    else if (arg === "--force" || arg === "-f") opts.force = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-color") opts.color = false;
    else if (arg === "--color") opts.color = true;
    else if (arg === "--help" || arg === "-h") return help();
    else if (arg === "--version" || arg === "-v") return version();
    else if (arg.startsWith("-") && arg !== "-") return usageError(`unknown option "${arg}"`);
    else positional.push(arg);
  }
  if (opts.color !== null) ui.setColorEnabled(opts.color);
  if (positional.length > 2) return usageError("too many arguments");

  const [first, second] = positional;
  if (!first || first === "list") {
    if (second !== undefined) return usageError(`"portfox list" takes no arguments`);
    return list(opts);
  }
  if (first === "kill") return withPort(second, "a port to kill", (p) => kill(p, opts));
  if (first === "find") return withPort(second, "a port to start from", (p) => find(p, opts));
  if (second !== undefined) return usageError(`unexpected argument "${second}"`);
  return withPort(first, "a port to inspect", (p) => inspect(p, opts));
}

/* --------------------------------- plumbing -------------------------------- */

// Ports are decimal numbers only: "3e3" and "0xBB8" are rejected instead of
// being silently reinterpreted as 3000.
function withPort(raw, what, fn) {
  if (raw === undefined) return usageError(`missing ${what}`);
  const input = String(raw).replace(/^:/, "");
  if (!/^\d+$/.test(input)) return usageError(`"${raw}" is not a valid port number`);
  const port = Number(input);
  if (port < 1 || port > 65535) return usageError(`port must be between 1 and 65535, got ${input}`);
  return fn(port);
}

function usageError(message) {
  err(`\n  portfox: ${message}\n  Run "portfox --help" for usage.\n`);
  return 2;
}

function version() {
  out(`portfox ${VERSION}\n`);
  return 0;
}

function help() {
  const rows = [
    ["portfox <port>", "Inspect a port (interactive on a TTY)"],
    ["portfox kill <port>", "Stop whatever is listening on a port"],
    ["portfox find <port>", "Show the next available ports"],
    ["portfox list", "List every port currently in use"],
    ["portfox", 'Same as "portfox list"'],
  ];
  const width = Math.max(...rows.map(([c]) => c.length));
  out(`\n  ${ui.bold(ui.cyan("PORTFOX"))} v${VERSION}\n\n`);
  out(`  See what's on a port - and free it - in one command.\n\n`);
  out(`  ${ui.dim("Usage")}\n`);
  for (const [cmd, text] of rows) out(`    ${cmd.padEnd(width)}  ${ui.dim(text)}\n`);
  out(`\n  ${ui.dim("Options")}\n`);
  for (const [flag, text] of [
    ["-f, --force", "Send SIGKILL instead of SIGTERM"],
    ["-y, --yes", "Confirm the kill up front (required outside a TTY)"],
    ["-j, --json", "Print machine-readable JSON"],
    ["    --no-color", "Disable colors (NO_COLOR is respected)"],
    ["-h, --help", "Show this help"],
    ["-v, --version", "Show the version"],
  ]) {
    out(`    ${flag.padEnd(width)}  ${ui.dim(text)}\n`);
  }
  out(`\n  ${ui.dim("Exit codes")}\n`);
  out(`    0  the port is free, or the action succeeded\n`);
  out(`    1  the port is occupied, or the action failed\n`);
  out(`    2  usage error\n\n`);
  return 0;
}

function describeTarget(listeners) {
  const targets = listeners.filter((l) => l.pid);
  if (!targets.length) return "the process";
  if (targets.length === 1) return `${targets[0].name || "process"} (PID ${targets[0].pid})`;
  return `${targets.length} processes`;
}

/* ---------------------------------- list ----------------------------------- */

async function list(opts) {
  const listeners = await ui.withSpinner("Scanning ports…", () => listListeners());
  const rows = listeners
    .flatMap((l) => l.ports.map((port) => ({ port, listener: l })))
    .sort((a, b) => a.port - b.port);

  const infos = new Map();
  const pids = [...new Set(rows.map((r) => r.listener.pid).filter(Boolean))];
  await Promise.all(pids.map(async (pid) => infos.set(pid, await getProcessInfo(pid))));

  const data = rows.map(({ port, listener }) => {
    const info = infos.get(listener.pid);
    return {
      port,
      process: listener.name || info?.name || null,
      pid: listener.pid,
      project: info?.cwd || null,
      addresses: listener.portAddresses?.[port] ?? listener.addresses,
    };
  });

  if (opts.json) {
    out(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  ui.printHeader();
  if (!data.length) {
    out(`  ${ui.dim("No listening ports found.")}\n\n`);
    return 0;
  }
  ui.printTable(
    ["PORT", "PROCESS", "PID", "PROJECT"],
    data.map((r) => [
      String(r.port),
      r.process || "?",
      r.pid ? String(r.pid) : "-",
      r.project ? ui.displayPath(r.project, 44) : "-",
    ])
  );
  out(`\n  ${ui.dim(`${data.length} listening ${data.length === 1 ? "port" : "ports"}`)}\n\n`);
  return 0;
}

/* --------------------------------- inspect --------------------------------- */

function asJson(port, result, infos) {
  return {
    port,
    occupied: result.occupied,
    reason: result.reason,
    processes: result.listeners.map((l, i) => {
      const info = infos[i];
      return {
        pid: l.pid,
        name: info?.name || l.name || null,
        command: info?.command ?? null,
        user: info?.user ?? null,
        cwd: info?.cwd ?? null,
        elapsedMs: info?.elapsedMs ?? null,
        startedAt: info?.startedAt ?? null,
        parent: info?.ppid ? { pid: info.ppid, name: info.parentName ?? null } : null,
        addresses: l.portAddresses?.[port] ?? l.addresses,
      };
    }),
  };
}

async function inspect(port, opts) {
  const result = await ui.withSpinner(`Scanning port ${port}…`, () => inspectPort(port));
  const infos = await Promise.all(result.listeners.map((l) => (l.pid ? getProcessInfo(l.pid) : null)));

  if (opts.json) {
    out(JSON.stringify(asJson(port, result, infos), null, 2) + "\n");
    return result.occupied ? 1 : 0;
  }

  ui.printHeader();
  if (!result.occupied) {
    ui.printAvailable(port);
    return 0;
  }
  ui.printSummary(port, result, infos);
  if (result.reason === "denied") return 1;
  if (!ui.isInteractive()) {
    ui.printHint(port);
    return 1;
  }
  return menu(port, result, infos, opts);
}

async function menu(port, result, infos, opts) {
  for (;;) {
    const choice = await ui.selectMenu(MENU);
    if (choice === null || choice === 3) return 1;

    if (choice === 1) {
      ui.printDetails(infos[0] || {}, result.listeners[0]?.portAddresses?.[port]);
      await ui.pressAnyKey("Press any key to go back");
      continue;
    }

    if (choice === 2) {
      const ports = await ui.withSpinner("Looking for a free port…", () => findAvailablePorts(port + 1, 3));
      if (!ports.length) {
        out(`  ${ui.red("✘")} No free port found near ${port}\n\n`);
        return 1;
      }
      out(`  ${ui.green("✔")} Port ${ui.yellow(String(ports[0]))} is available\n\n`);
      out(`  ${ui.dim(`Next free ports: ${ports.join(", ")}`)}\n\n`);
      await ui.pressAnyKey("Press any key to go back");
      continue;
    }

    const target = describeTarget(result.listeners);
    if (!killTargets(result.listeners).length) {
      out(`  ${ui.red("✘")} Could not identify the process - try ${ui.cyan(`sudo portfox ${port}`)}\n\n`);
      continue;
    }
    await warnSideEffects(port, result.listeners);
    if (!(await ui.confirm(`Kill ${target}?`))) continue;
    let outcome = await ui.withSpinner("Stopping…", () => stop(port, result.listeners, opts.force));
    if (!outcome.stopped && outcome.reason === "alive" && !opts.force) {
      if (await ui.confirm(`${target} did not exit. Force kill (SIGKILL)?`)) {
        outcome = await ui.withSpinner("Stopping…", () => stop(port, result.listeners, true));
      }
    }
    return report(port, result.listeners, outcome);
  }
}

/* ---------------------------------- kill ----------------------------------- */

async function kill(port, opts) {
  const result = await ui.withSpinner(`Scanning port ${port}…`, () => inspectPort(port));
  if (!result.occupied) {
    ui.printHeader();
    out(`  ${ui.green("✔")} Port ${ui.yellow(String(port))} is not in use\n\n`);
    return 0;
  }
  const infos = await Promise.all(result.listeners.map((l) => (l.pid ? getProcessInfo(l.pid) : null)));
  ui.printHeader();
  ui.printSummary(port, result, infos);

  if (!killTargets(result.listeners).length) {
    out(`  ${ui.red("✘")} Could not identify the process - try ${ui.cyan(`sudo portfox kill ${port}`)}\n\n`);
    return 1;
  }

  // No terminal means no one to ask: require --yes so a stray kill in a
  // script or CI job can never stop a process on its own.
  if (!ui.isInteractive() && !opts.yes) {
    out(`  ${ui.red("✘")} Refusing to kill without confirmation in a non-interactive shell.\n`);
    out(`    Pass ${ui.cyan("--yes")} to go ahead: ${ui.cyan(`portfox kill ${port} --yes`)}\n\n`);
    return 1;
  }

  await warnSideEffects(port, result.listeners);
  if (ui.isInteractive() && !opts.yes) {
    const target = describeTarget(result.listeners);
    if (!(await ui.confirm(`Kill ${target}?`))) return 1;
  }

  let outcome = await ui.withSpinner("Stopping…", () => stop(port, result.listeners, opts.force));
  if (!outcome.stopped && outcome.reason === "alive" && !opts.force && ui.isInteractive() && !opts.yes) {
    if (await ui.confirm("It did not exit. Force kill (SIGKILL)?")) {
      outcome = await ui.withSpinner("Stopping…", () => stop(port, result.listeners, true));
    }
  }
  return report(port, result.listeners, outcome);
}

const killTargets = (listeners) =>
  listeners.filter((l) => l.pid && l.pid !== process.pid).map((l) => l.pid);

async function warnSideEffects(port, listeners) {
  const extra = await ui.withSpinner("Checking for side effects…", () =>
    otherPortsForPids(killTargets(listeners), port)
  );
  if (extra.length) {
    out(`  ${ui.yellow("!")} ${describeTarget(listeners)} also listens on ${extra.join(", ")} - killing it closes those too.\n\n`);
  }
}

async function stop(port, listeners, force) {
  const targets = killTargets(listeners);
  if (!targets.length) return { stopped: false, reason: "unknown" };

  // Re-check right before signaling: if nothing holds the port anymore, the
  // original PIDs are stale (or recycled) and must not be touched.
  const { alive, vanished } = await revalidateTargets(port, targets);
  if (!alive.length) return { stopped: false, reason: "vanished", vanished };

  let eperm = false;
  const sent = [];
  for (const pid of alive) {
    const res = sendSignal(pid, force ? "SIGKILL" : "SIGTERM");
    if (res.ok) sent.push(pid);
    else if (res.reason === "eperm") eperm = true;
    // "gone" between revalidate and signal: there is nothing to stop.
  }
  if (!sent.length) return { stopped: false, reason: eperm ? "eperm" : "vanished", vanished };
  const exited = await waitForAllExit(sent, force ? 2000 : 3000);
  return { stopped: exited, reason: exited ? null : "alive", vanished, eperm };
}

async function report(port, listeners, outcome) {
  if (outcome.stopped) {
    out(`  ${ui.green("✔")} Stopped ${ui.bold(describeTarget(listeners))}\n\n`);
    if (outcome.vanished?.length) {
      out(`  ${ui.dim(`Skipped ${outcome.vanished.length} PID(s) that no longer held the port.`)}\n\n`);
    }
    if (outcome.eperm) {
      out(`  ${ui.yellow("!")} Some processes could not be signaled (permission denied).\n\n`);
    }
    const state = await probePort(port);
    if (state === "free") {
      out(`  Port ${ui.yellow(String(port))} is now free.\n\n`);
      return 0;
    }
    out(`  ${ui.yellow("!")} Port ${port} is still in use.\n\n`);
    return 1;
  }
  if (outcome.reason === "eperm") {
    out(`  ${ui.red("✘")} Permission denied - try ${ui.cyan(`sudo portfox kill ${port}`)}\n\n`);
    return 1;
  }
  if (outcome.reason === "unknown") {
    out(`  ${ui.red("✘")} Could not identify the process - try ${ui.cyan(`sudo portfox ${port}`)}\n\n`);
    return 1;
  }
  if (outcome.reason === "vanished") {
    out(`  ${ui.yellow("!")} ${describeTarget(listeners)} no longer holds port ${port} - nothing was killed.\n\n`);
    const state = await probePort(port);
    if (state === "free") {
      out(`  Port ${ui.yellow(String(port))} is free.\n\n`);
      return 0;
    }
    out(`  ${ui.dim("Whoever holds it now was left untouched.")}\n\n`);
    return 1;
  }
  out(`  ${ui.yellow("!")} ${describeTarget(listeners)} is still running. Retry with ${ui.cyan("--force")}.\n\n`);
  return 1;
}

/* ---------------------------------- find ----------------------------------- */

async function find(port, opts) {
  const ports = await ui.withSpinner(`Looking for free ports after ${port}…`, () => findAvailablePorts(port + 1, 3));
  if (opts.json) {
    out(JSON.stringify({ port, ports }, null, 2) + "\n");
    return ports.length ? 0 : 1;
  }
  ui.printHeader();
  if (!ports.length) {
    out(`  ${ui.red("✘")} No free port found near ${port}\n\n`);
    return 1;
  }
  out(`  ${ui.green("✔")} Port ${ui.yellow(String(ports[0]))} is available\n\n`);
  out(`  ${ui.dim(`Next free ports: ${ports.join(", ")}`)}\n\n`);
  return 0;
}

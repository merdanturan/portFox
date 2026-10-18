// End-to-end kill flow: the CLI is spawned as a real child process (so it has
// no TTY, exactly like CI) and talks to a throwaway server started per test.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findAvailablePorts,
  isAlive,
  otherPortsForPids,
  probePort,
  revalidateTargets,
  sendSignal,
} from "../src/ports.js";

const CLI = fileURLToPath(new URL("../bin/portfox.js", import.meta.url));

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function freePorts(count) {
  const start = 20000 + Math.floor(Math.random() * 20000);
  const ports = await findAvailablePorts(start, count, 300);
  assert.equal(ports.length, count, `could not find ${count} free ports near ${start}`);
  return ports;
}

// A tiny node process that listens on the given ports and does nothing else.
function spawnServer(ports) {
  const code = `
    const net = require("net");
    const ports = ${JSON.stringify(ports)};
    for (const p of ports) net.createServer((s) => s.end()).listen(p, "127.0.0.1");
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test server did not start")), 5000);
    timer.unref();
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve(child);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("test server exited early"));
    });
  });
}

function waitExit(child, ms = 5000) {
  // A signal-killed child keeps exitCode === null and sets signalCode instead.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopServer(child) {
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitExit(child);
}

test("inspect finds the right PID; a free port exits 0", async () => {
  const [busy] = await freePorts(1);
  const server = await spawnServer([busy]);
  try {
    const res = await runCli([String(busy), "--json"]);
    assert.equal(res.code, 1);
    const data = JSON.parse(res.stdout);
    assert.equal(data.occupied, true);
    assert.equal(data.processes[0].pid, server.pid);
  } finally {
    await stopServer(server);
  }

  const [free] = await freePorts(1);
  const res = await runCli([String(free)]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
});

test("kill in a non-interactive shell without --yes is refused", async () => {
  const [port] = await freePorts(1);
  const server = await spawnServer([port]);
  try {
    const res = await runCli(["kill", String(port)]);
    assert.equal(res.code, 1);
    assert.match(res.stdout + res.stderr, /--yes/);
    assert.equal(isAlive(server.pid), true, "the server must still be running");
    assert.equal(await probePort(port), "in-use");
  } finally {
    await stopServer(server);
  }
});

test("kill --yes stops the listener and frees the port", async () => {
  const [port] = await freePorts(1);
  const server = await spawnServer([port]);
  try {
    const res = await runCli(["kill", String(port), "--yes"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await waitExit(server), true, "the server should exit after SIGTERM");
    assert.equal(await probePort(port), "free");
  } finally {
    await stopServer(server);
  }
});

test("kill --json --yes returns JSON after stopping a real listener", async () => {
  const [port] = await freePorts(1);
  const server = await spawnServer([port]);
  try {
    const res = await runCli(["kill", String(port), "--json", "--yes"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const result = JSON.parse(res.stdout);
    assert.equal(result.port, port);
    assert.equal(result.success, true);
    assert.equal(result.occupied, false);
    assert.equal(result.processes[0].pid, server.pid);
    assert.equal(await waitExit(server), true);
    assert.equal(await probePort(port), "free");
  } finally {
    await stopServer(server);
  }
});

test("kill on a free port exits 0 without doing anything", async () => {
  const [port] = await freePorts(1);
  const res = await runCli(["kill", String(port), "--yes"]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /not in use/);
});

test("kill warns when the same process listens on other ports too", async () => {
  const [p1, p2] = await freePorts(2);
  const server = await spawnServer([p1, p2]);
  try {
    const res = await runCli(["kill", String(p1), "--yes"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`\\b${p2}\\b`), "the other port must be mentioned");
    assert.equal(await waitExit(server), true);
  } finally {
    await stopServer(server);
  }
});

test("a vanished listener is never replaced by a wrong kill", async () => {
  const [port] = await freePorts(1);
  const first = await spawnServer([port]);
  const stalePid = first.pid;
  await stopServer(first);

  const second = await spawnServer([port]);
  try {
    const { alive, vanished } = await revalidateTargets(port, [stalePid]);
    assert.deepEqual(alive, [], "the stale PID must not be considered alive on the port");
    assert.deepEqual(vanished, [stalePid]);
    assert.equal(isAlive(second.pid), true, "the new listener must be untouched");
  } finally {
    await stopServer(second);
  }
});

test("otherPortsForPids reports the side-effect ports", async () => {
  const [p1, p2] = await freePorts(2);
  const server = await spawnServer([p1, p2]);
  try {
    assert.deepEqual(await otherPortsForPids([server.pid], p1), [p2]);
  } finally {
    await stopServer(server);
  }
});

test("list --json keeps addresses scoped to their own port", async () => {
  const [p1, p2] = await freePorts(2);
  const server = await spawnServer([p1, p2]);
  try {
    const res = await runCli(["list", "--json"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const rows = JSON.parse(res.stdout).filter((r) => r.pid === server.pid);
    assert.equal(rows.length, 2, "one row per listening port");
    for (const row of rows) {
      assert.ok(row.addresses.length >= 1, `port ${row.port} should list an address`);
      for (const address of row.addresses) {
        assert.ok(address.endsWith(`:${row.port}`), `${address} does not belong to port ${row.port}`);
      }
    }
  } finally {
    await stopServer(server);
  }
});

test("unauthorized processes produce a clear error", (t) => {
  // Exercise the OS error boundary without ever signaling a host service.
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  const res = sendSignal(12345, "SIGTERM");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "eperm");
  assert.equal(isAlive(12345), true, "permission denied does not mean the process is gone");
});

test("port syntax is validated strictly", async () => {
  for (const bad of ["3e3", "0xBB8", "3000.5", "abc", "0", "65536", " "]) {
    const res = await runCli([bad]);
    assert.equal(res.code, 2, `"${bad}" should be a usage error: ${res.stdout + res.stderr}`);
  }
  const octalish = await runCli([":3000"]);
  assert.notEqual(octalish.code, 2, "a leading colon is a convenience, not an error");
});

test("extra arguments are rejected", async () => {
  const list = await runCli(["list", "3000"]);
  assert.equal(list.code, 2, list.stdout + list.stderr);
  const inspect = await runCli(["3000", "extra"]);
  assert.equal(inspect.code, 2, inspect.stdout + inspect.stderr);
  const kill = await runCli(["kill", "3000", "extra"]);
  assert.equal(kill.code, 2, kill.stdout + kill.stderr);
});

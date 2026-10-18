import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import net from "node:net";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { promisify, stripVTControlCharacters } from "node:util";

// Replace OS boundaries only: these fixtures exercise the real discovery,
// command, rendering and keyboard flows without touching host processes.
let commands;
childProcess.execFile = (cmd, args, options, callback) => {
  queueMicrotask(() => {
    const result = commands(cmd, args);
    if (result.error) {
      callback(Object.assign(new Error("command failed"), {
        stdout: "", stderr: "", ...result.error,
      }), result.stdout || "", result.stderr || "");
    } else callback(null, result.stdout || "", "");
  });
};
childProcess.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
  childProcess.execFile(...args, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});
syncBuiltinESMExports();
const ports = await import("../src/ports.js");
const ui = await import("../src/ui.js");
const { main } = await import("../src/cli.js");

beforeEach(() => {
  commands = () => ({ error: { code: "ENOENT" } });
});

function capture(t) {
  let stdout = "";
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...args) => {
    if (typeof chunk !== "string") return write(chunk, ...args);
    stdout += chunk;
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) queueMicrotask(callback);
    return true;
  });
  return () => stdout;
}

function property(t, object, key, value) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, value });
  t.after(() => original ? Object.defineProperty(object, key, original) : delete object[key]);
}

function freeProbe(t) {
  t.mock.method(net, "createServer", () => {
    const server = new EventEmitter();
    server.unref = () => server;
    server.listen = (options, callback) => { queueMicrotask(callback); return server; };
    server.close = (callback) => { callback(); return server; };
    return server;
  });
}

test("list reports unavailable scanners as failure, not an empty successful list", async (t) => {
  const output = capture(t);
  const code = await main(["list", "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(output()).error.code, "PORT_SCAN_FAILED");
});

test("kill scan errors retain the normalized port in JSON", async (t) => {
  const output = capture(t);
  assert.equal(await main(["kill", ":3000", "--json", "--yes"]), 1);
  const result = JSON.parse(output());
  assert.equal(result.port, 3000);
  assert.equal(result.success, false);
  assert.equal(result.error.code, "PORT_SCAN_FAILED");
});

test("JSON mode reports usage errors as JSON with exit code 2", async (t) => {
  const output = capture(t);
  assert.equal(await main(["kill", "3e3", "--json"]), 2);
  assert.equal(JSON.parse(output()).error.code, "USAGE_ERROR");
});

test("a failed scanner falls back instead of hiding listeners", async () => {
  commands = (cmd) => cmd === "lsof"
    ? { error: { code: 2, stderr: "permission denied" } }
    : cmd === "ss"
      ? { stdout: 'LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12345,fd=8))' }
      : { error: { code: "ENOENT" } };
  if (process.platform === "darwin" || process.platform === "win32") {
    await assert.rejects(ports.findListeners(3000), { code: "PORT_SCAN_FAILED" });
  } else {
    const result = await ports.findListeners(3000);
    assert.equal(result[0].pid, 12345);
  }
});

test("lsof exit 1 with empty output means no matches", { skip: process.platform === "win32" }, async () => {
  commands = (cmd) => cmd === "lsof" ? { error: { code: 1 } } : { error: { code: "ENOENT" } };
  assert.deepEqual(await ports.listListeners(), []);
});

test("lsof exit 1 with a diagnostic is a scan failure", { skip: process.platform === "win32" }, async () => {
  commands = (cmd) => cmd === "lsof"
    ? { error: { code: 1, stderr: "permission denied" } }
    : { error: { code: "ENOENT" } };
  await assert.rejects(ports.listListeners(), { code: "PORT_SCAN_FAILED" });
});

test("timed out scanners cannot turn partial output into a successful scan", async () => {
  commands = () => ({ error: { code: 1, killed: true, stdout: "p12345\ncnode\nn*:3000\n" } });
  await assert.rejects(ports.listListeners(), { code: "PORT_SCAN_FAILED" });
});

function scanner(cmd) {
  if (cmd === "lsof") return { stdout: "p12345\ncnode\nn127.0.0.1:3000\n" };
  if (cmd === "netstat") return { stdout: "TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 12345" };
  return { stdout: "" };
}

test("kill --json refuses missing confirmation with JSON and never signals", async (t) => {
  commands = scanner;
  const output = capture(t);
  property(t, process.stdin, "isTTY", true);
  property(t, process.stdout, "isTTY", true);
  t.mock.method(process, "kill", () => assert.fail("must not signal without confirmation"));
  const code = await main(["kill", "3000", "--json"]);
  assert.equal(code, 1);
  const result = JSON.parse(output());
  assert.equal(result.port, 3000);
  assert.equal(result.success, false);
  assert.equal(result.reason, "confirmation-required");
});

test("kill --json on a free port returns a successful JSON result", async (t) => {
  commands = () => ({ stdout: "" });
  freeProbe(t);
  const output = capture(t);
  assert.equal(await main(["kill", "3000", "--json", "--yes"]), 0);
  const result = JSON.parse(output());
  assert.equal(result.success, true);
  assert.equal(result.occupied, false);
  assert.deepEqual(result.processes, []);
});

test("kill --json reports signaled processes and verifies that the port is free", async (t) => {
  commands = (cmd, args) => {
    if (cmd === "lsof" && args.includes("-iTCP")) {
      return { stdout: "p12345\ncnode\nn127.0.0.1:3000\nn127.0.0.1:4000\n" };
    }
    if (cmd === "netstat") {
      return { stdout: "TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 12345\nTCP 127.0.0.1:4000 0.0.0.0:0 LISTENING 12345" };
    }
    return scanner(cmd);
  };
  freeProbe(t);
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    signals.push([pid, signal]);
  });
  const output = capture(t);
  assert.equal(await main(["kill", "3000", "--json", "--yes"]), 0);
  const result = JSON.parse(output());
  assert.equal(result.success, true);
  assert.equal(result.occupied, false);
  assert.equal(result.processes[0].pid, 12345);
  assert.deepEqual(result.otherPorts, [4000]);
  assert.deepEqual(signals, [[12345, "SIGTERM"]]);
});

test("kill --json reports permission errors without claiming success", async (t) => {
  commands = scanner;
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  const output = capture(t);
  assert.equal(await main(["kill", "3000", "--json", "--yes"]), 1);
  assert.equal(JSON.parse(output()).reason, "permission-denied");
});

test("multiple listeners with missing process details render without crashing", (t) => {
  const output = capture(t);
  ui.printSummary(3000, {
    reason: "listen", listeners: [{ pid: 12345, name: "node" }, { pid: 54321, name: "python" }],
  }, [null, null]);
  assert.match(output(), /node/);
  assert.match(output(), /python/);
  assert.match(output(), /54321/);
});

test("interactive list opens a freshly inspected port and returns to the list", async (t) => {
  const output = capture(t);
  freeProbe(t);
  property(t, process.stdin, "isTTY", true);
  property(t, process.stdout, "isTTY", true);
  property(t, process.stderr, "isTTY", false);
  property(t, process.stdin, "setRawMode", () => {});
  t.mock.method(process.stdin, "resume", () => process.stdin);
  t.mock.method(process.stdin, "pause", () => process.stdin);
  let inspected = false;
  commands = (cmd, args) => {
    if (cmd === "lsof" && args.includes("-iTCP:3000")) {
      inspected = true;
      return { stdout: "" };
    }
    if (cmd === "netstat") {
      if (args.includes("-ano")) return scanner(cmd);
    }
    return scanner(cmd);
  };
  // Enter selects the first row; q exits the refreshed list. Windows scanners
  // do not accept a port filter, so cancel its inspection menu as well.
  setImmediate(() => process.stdin.emit("data", Buffer.from(process.platform === "win32" ? "\rqq" : "\rq")));
  assert.equal(await main(["list"]), 0);
  if (process.platform !== "win32") assert.equal(inspected, true);
  assert.match(output(), /3000/);
});

test("long menus keep navigation and selection working across pages", async (t) => {
  const output = capture(t);
  property(t, process.stdin, "isTTY", true);
  property(t, process.stdout, "isTTY", true);
  property(t, process.stdout, "rows", 10);
  property(t, process.stdin, "setRawMode", () => {});
  t.mock.method(process.stdin, "resume", () => process.stdin);
  t.mock.method(process.stdin, "pause", () => process.stdin);
  setImmediate(() => process.stdin.emit("data", Buffer.from("jjjj\r")));
  const choice = await ui.selectMenu(Array.from({ length: 30 }, (_, index) => `row-${index}`));
  assert.equal(choice, 4);
  assert.match(output(), /❯ row-4/);
  assert.doesNotMatch(output(), /row-29/);
});

test("wide menu rows fit an 80-column terminal without wrapping redraws", async (t) => {
  const output = capture(t);
  property(t, process.stdin, "isTTY", true);
  property(t, process.stdout, "isTTY", true);
  property(t, process.stdout, "columns", 80);
  property(t, process.stdin, "setRawMode", () => {});
  t.mock.method(process.stdin, "resume", () => process.stdin);
  t.mock.method(process.stdin, "pause", () => process.stdin);
  ui.setColorEnabled(true);
  t.after(() => ui.setColorEnabled(false));
  setImmediate(() => process.stdin.emit("data", Buffer.from("j\r")));
  assert.equal(await ui.selectMenu(["3000 node " + "x".repeat(100), "4000 node " + "y".repeat(100)]), 1);
  const widths = output().split("\n").map((line) => stripVTControlCharacters(line).replace(/\r/g, "").length);
  assert.ok(Math.max(...widths) <= 80, `menu rendered a ${Math.max(...widths)}-column line`);
});

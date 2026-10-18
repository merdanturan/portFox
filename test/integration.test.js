import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { bindTest, findAvailablePorts, inspectPort, probePort } from "../src/ports.js";

function listen(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test("inspectPort sees a listener, then a free port", async () => {
  const server = await listen();
  const port = server.address().port;
  try {
    const result = await inspectPort(port);
    assert.equal(result.occupied, true);
    // lsof/ss may be missing in some sandboxes; probePort alone still proves it.
    if (result.listeners.length) {
      assert.ok(
        result.listeners.some((l) => l.pid === process.pid),
        `expected pid ${process.pid} in ${JSON.stringify(result.listeners)}`
      );
    }
  } finally {
    await close(server);
  }
  const after = await inspectPort(port);
  assert.equal(after.occupied, false);
  assert.equal(await probePort(port), "free");
});

test("findAvailablePorts skips occupied ports", async () => {
  const server = await listen();
  const port = server.address().port;
  try {
    const [first] = await findAvailablePorts(port, 1, 5);
    assert.ok(first > port, `expected a port after ${port}, got ${first}`);
    assert.equal(await probePort(first), "free");
  } finally {
    await close(server);
  }
});

test("probePort and findAvailablePorts see IPv6-only listeners", async (t) => {
  let server;
  try {
    server = await listen("::1");
  } catch (err) {
    if (typeof t.skip === "function") t.skip(`no IPv6 loopback here (${err.code || err.message})`);
    return;
  }
  const port = server.address().port;
  try {
    assert.equal(await probePort(port), "in-use");
    const [next] = await findAvailablePorts(port, 1, 5);
    assert.ok(next > port, `port ${port} is taken on ::1, expected a later free port, got ${next}`);
  } finally {
    await close(server);
  }
  assert.equal(await probePort(port), "free");
});

test("bindTest separates unusable addresses from busy ones", async () => {
  // TEST-NET-3: never assigned to a local interface, so the bind fails with
  // EADDRNOTAVAIL even though the port may be perfectly free.
  const res = await bindTest(34567, "203.0.113.1");
  assert.ok(res === "unavailable" || res === "error", `expected unavailable/error, got ${res}`);
});

test("probePort classifies privileged ports as denied", { skip: process.platform === "win32" || (process.getuid && process.getuid() === 0) }, async () => {
  const res = await bindTest(80, "127.0.0.1");
  assert.ok(res === "denied" || res === "in-use", `expected denied/in-use, got ${res}`);
});

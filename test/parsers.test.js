import test from "node:test";
import assert from "node:assert/strict";
import {
  listenersFromLsof,
  listenersFromRows,
  parseLsofFieldOutput,
  parseNetstatUnix,
  parseNetstatWindows,
  parseSsOutput,
  portFromSocketName,
} from "../src/ports.js";

test("portFromSocketName", () => {
  assert.equal(portFromSocketName("127.0.0.1:3000"), 3000);
  assert.equal(portFromSocketName("[::1]:3000"), 3000);
  assert.equal(portFromSocketName("*:8080"), 8080);
  assert.equal(portFromSocketName("127.0.0.1:3000->1.2.3.4:55000"), 3000);
  assert.equal(portFromSocketName("nonsense"), null);
});

test("parseLsofFieldOutput groups fields per process", () => {
  const out = [
    "p48291",
    "cnode",
    "n127.0.0.1:3000",
    "p123",
    "cpython3.11",
    "n*:8080",
    "n[::1]:8080",
    "",
  ].join("\n");
  const entries = parseLsofFieldOutput(out);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { pid: 48291, name: "node", sockets: ["127.0.0.1:3000"] });
  assert.deepEqual(entries[1], {
    pid: 123,
    name: "python3.11",
    sockets: ["*:8080", "[::1]:8080"],
  });
});

test("parseSsOutput reads listeners with and without process info", () => {
  const out = [
    'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=48291,fd=18))',
    'LISTEN 0 4096 [::]:3000 [::]:* users:(("node",pid=48291,fd=19),("node",pid=999,fd=5))',
    "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    "ESTAB 0 0 10.0.0.2:55000 1.1.1.1:443",
  ].join("\n");
  const rows = parseSsOutput(out);
  assert.deepEqual(rows, [
    { pid: 48291, name: "node", port: 3000, address: "127.0.0.1:3000" },
    { pid: 48291, name: "node", port: 3000, address: "[::]:3000" },
    { pid: 999, name: "node", port: 3000, address: "[::]:3000" },
    { pid: null, name: null, port: 22, address: "0.0.0.0:22" },
  ]);
});

test("parseNetstatUnix reads pid/name columns when present", () => {
  const out = [
    "tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN 48291/node",
    "tcp6 0 0 :::8080 :::* LISTEN -",
  ].join("\n");
  const rows = parseNetstatUnix(out);
  assert.deepEqual(rows, [
    { pid: 48291, name: "node", port: 3000, address: "127.0.0.1:3000" },
    { pid: null, name: null, port: 8080, address: ":::8080" },
  ]);
});

test("parseNetstatWindows reads LISTENING rows only", () => {
  const out = [
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       48291",
    "  TCP    127.0.0.1:5000         0.0.0.0:0              ESTABLISHED     111",
  ].join("\n");
  const rows = parseNetstatWindows(out);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { pid: 48291, name: null, port: 3000, address: "0.0.0.0:3000" });
});

test("listenersFromLsof maps addresses to the port they belong to", () => {
  const out = [
    "p48291",
    "cnode",
    "n127.0.0.1:3000",
    "n[::1]:3000",
    "n127.0.0.1:8080",
    "",
  ].join("\n");
  const [listener] = listenersFromLsof(out);
  assert.deepEqual(listener.ports, [3000, 8080]);
  assert.deepEqual(listener.portAddresses[3000], ["127.0.0.1:3000", "[::1]:3000"]);
  assert.deepEqual(listener.portAddresses[8080], ["127.0.0.1:8080"]);
});

test("listenersFromLsof filters to a single port when asked", () => {
  const out = ["p48291", "cnode", "n127.0.0.1:3000", "n127.0.0.1:8080", ""].join("\n");
  const [listener] = listenersFromLsof(out, 3000);
  assert.deepEqual(listener.ports, [3000]);
  assert.deepEqual(listener.portAddresses[3000], ["127.0.0.1:3000"]);
  assert.equal(listener.portAddresses[8080], undefined);
});

test("listenersFromRows keeps per-port addresses when a PID has several ports", () => {
  const listeners = listenersFromRows([
    { pid: 48291, name: "node", port: 3000, address: "127.0.0.1:3000" },
    { pid: 48291, name: "node", port: 8080, address: "[::]:8080" },
    { pid: null, name: null, port: 22, address: "0.0.0.0:22" },
  ]);
  const node = listeners.find((l) => l.pid === 48291);
  assert.deepEqual(node.ports, [3000, 8080]);
  assert.deepEqual(node.portAddresses[3000], ["127.0.0.1:3000"]);
  assert.deepEqual(node.portAddresses[8080], ["[::]:8080"]);
  const unknown = listeners.find((l) => l.pid === null);
  assert.deepEqual(unknown.portAddresses[22], ["0.0.0.0:22"]);
});

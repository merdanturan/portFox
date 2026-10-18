import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { displayPath, humanizeDuration, parseEtime, shortenPath, tildify } from "../src/ui.js";

test("parseEtime: mm:ss", () => {
  assert.equal(parseEtime("14:05"), (14 * 60 + 5) * 1000);
});

test("parseEtime: hh:mm:ss", () => {
  assert.equal(parseEtime("02:03:04"), ((2 * 60 + 3) * 60 + 4) * 1000);
});

test("parseEtime: dd-hh:mm:ss", () => {
  assert.equal(parseEtime("1-02:03:04"), (((24 + 2) * 60 + 3) * 60 + 4) * 1000);
});

test("parseEtime: garbage", () => {
  assert.equal(parseEtime(""), null);
  assert.equal(parseEtime("abc"), null);
});

test("humanizeDuration", () => {
  assert.equal(humanizeDuration(2_000), "a few seconds");
  assert.equal(humanizeDuration(30_000), "30 seconds");
  assert.equal(humanizeDuration(60_000), "1 minute");
  assert.equal(humanizeDuration(14 * 60_000), "14 minutes");
  assert.equal(humanizeDuration(3_600_000), "1 hour");
  assert.equal(humanizeDuration(5 * 3_600_000), "5 hours");
  assert.equal(humanizeDuration(2 * 86_400_000), "2 days");
});

test("tildify replaces the home directory", () => {
  const home = os.homedir();
  assert.equal(tildify(home), "~");
  assert.equal(tildify(home + "/Projects/app"), "~/Projects/app");
  assert.equal(tildify("/etc"), "/etc");
  assert.equal(tildify(null), null);
});

test("displayPath hides meaningless paths", () => {
  assert.equal(displayPath("/"), "-");
  assert.equal(displayPath(null), "-");
  assert.equal(displayPath(os.homedir()), "~");
});

test("shortenPath keeps the tail", () => {
  const long = "/very/long/" + "x".repeat(60);
  const short = shortenPath(long, 20);
  assert.equal(short.length, 20);
  assert.ok(short.startsWith("…"));
  assert.ok(short.endsWith("x"));
  assert.equal(shortenPath("/a/b", 20), "/a/b");
});

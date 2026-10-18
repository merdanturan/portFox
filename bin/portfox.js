#!/usr/bin/env node
import { main } from "../src/cli.js";

// Piping into `head` and friends closes stdout early; that's not an error.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  },
  (err) => {
    if (err && err.code === "EPIPE") process.exit(0);
    process.stderr.write(`\n  portfox: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  }
);

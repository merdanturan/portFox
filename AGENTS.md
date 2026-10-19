# AGENTS.md - portFox

Rules for AI coding agents in this repository. They add to the global AGENTS.md
(`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`).

PortFox is a zero-dependency Node.js CLI that shows what holds a TCP port and frees it. It is
published to npm as `portfox` (`npx portfox 3000`).

## Layout
- `bin/portfox.js` - entry point: turns the result of `main()` into the exit code, ignores EPIPE.
- `src/cli.js` - argument parsing and the command flows (inspect, kill, find, list, menus, JSON).
- `src/ports.js` - everything that touches the OS: lsof / ss / netstat / tasklist, bind probes,
  process details, signals. Parsers are exported for tests.
- `src/ui.js` - rendering, colors, spinner, interactive menus.
- `test/` - `node:test` suites. `regressions.test.js` mocks `execFile`, `net` and `process.kill`;
  `kill.test.js` spawns throwaway servers on random high ports and kills only those.
- `scripts/demo-server.mjs` and `demo.tape` - the README demo, recorded with vhs (`npm run demo`).

## Invariants (never break these)
1. Zero runtime dependencies, and no devDependencies unless I agree. Node built-ins only
   (`node:` imports), ES modules, no build step.
2. Node 18 compatibility (`engines: >=18`): no API newer than Node 18 without a fallback.
3. System tools run through `execFile` with argument arrays: never through a shell, never with
   interpolated command strings. Keep `LC_ALL=C`, the timeout and `maxBuffer`.
4. Kill safety: SIGTERM first; SIGKILL only with `--force` or after an explicit confirmation;
   PIDs are re-validated right before signaling; our own PID is never a target; without a TTY, and
   always with `--json`, killing requires `--yes`. Never weaken any of these.
5. A failed port scan is an error (exit 1), never an empty list. Only `EADDRINUSE` means "busy".
6. The public API follows semver: commands, flags, exit codes (0 free/success, 1 occupied/failed,
   2 usage error), JSON field names and the `reason` / `error.code` values. Changing or removing
   any of them is a breaking change: ask first, then update the README and `--help`. Adding JSON
   fields is fine.
7. Platform support: macOS needs `lsof`; Linux falls back `lsof` → `ss` → `netstat`; Windows uses
   `netstat -ano` + `tasklist` (best effort). Fallbacks must keep working when a tool is missing.
8. The package stays small: only `bin/` and `src/` are published (`files` in package.json). Check
   with `npm pack --dry-run` after adding files.

## Code style
- Plain JavaScript (ESM): two-space indent, double quotes, semicolons, like the existing code.
- Parsers stay pure functions that tests can feed with real tool output.
- `--json` prints exactly one JSON document to stdout. Human output goes through `ui.js` and
  respects `NO_COLOR`, `--no-color` and non-TTY output.

## Verify before saying "done"
1. `npm test` (runs `node --test`; nothing to install).
2. Tests never depend on what runs on the machine: random high ports, mocks, and only processes the
   test started itself may be killed.
3. Parser changes get a test with real tool output in `test/parsers.test.js`; kill and JSON changes
   get tests in `test/kill.test.js` or `test/regressions.test.js`.
4. Interactive menus can't be driven here: list what I should try in a real terminal.

CI (`.github/workflows/ci.yml`) runs `node --test` on ubuntu, macOS and Windows with Node 18, 20
and 22.

## Releases (never publish yourself)
- `.github/workflows/release.yml` publishes to npm with trusted publishing (no npm token) and
  creates the GitHub release when a `vX.Y.Z` tag is pushed. The tag must match the package.json
  version; tags with a `-` (e.g. `v0.3.0-beta.1`) publish under the `next` dist-tag.
- I release with `npm version patch|minor|major` and `git push --follow-tags`. Never run
  `npm publish`, `npm version`, `git tag` or `git push` yourself; you may prepare the change and
  the release notes.

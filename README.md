# PortFox

> See what's on a port - and free it - in one command.

You know the drill:

```console
Error: Port 3000 is already in use
```

Then: `lsof -i :3000`, copy a PID, `kill <pid>`, hope you killed the right thing.

**PortFox** turns that into one command:

```console
$ portfox 3000

  PORTFOX

  Port 3000 is occupied

  Process:   node
  PID:       48291
  Project:   ~/Projects/my-react-app
  Started:   14 minutes ago

  ┌────────────────────────────┐
  │ ❯ Stop process             │
  │   View process details     │
  │   Find available port      │
  │   Cancel                   │
  └────────────────────────────┘
```

Pick with `↑`/`↓` (or `j`/`k`), press `Enter`. Killing asks for confirmation unless you pass `--yes` - and in scripts, where nobody can answer, an explicit `--yes` is required. PortFox re-checks that the selected processes still hold the port before signaling them, then verifies the port is actually free.

Run `portfox` or `portfox list` in a terminal to select a row and manage that port. Returning from the port menu refreshes the list. Press `q` or `Esc` to quit. In pipes and scripts, the list remains a plain table; `--json` remains non-interactive.

![PortFox demo](./assets/demo.gif)

## Install

```sh
# one-off, no install
npx portfox 3000

# or globally
npm install -g portfox
```

Requires Node 18+. Zero dependencies - the published package is ~13 KB.

## Usage

```console
portfox <port>          Inspect a port (interactive on a TTY)
portfox kill <port>     Stop whatever is listening on a port
portfox find <port>     Show the next free ports
portfox list            List every port currently in use
portfox                 Same as "portfox list"
```

| Option | Description |
| --- | --- |
| `-f, --force` | Send SIGKILL instead of SIGTERM |
| `-y, --yes` | Confirm the kill up front (required outside a TTY) |
| `-j, --json` | Machine-readable output |
| `--no-color` | Disable colors (`NO_COLOR` is respected) |
| `-h, --help` | Show help |
| `-v, --version` | Show the version |

### Scripts

`portfox <port>` is script-friendly: it exits `1` when the port is busy and `0` when it's free.

```sh
portfox 3000 || echo "something is already on 3000"

# who is it, as JSON?
portfox 3000 --json | jq '.processes[0] | {name, pid, cwd}'

# free it
portfox kill 3000 --yes

# free it and read the result in a script
portfox kill 3000 --yes --json
```

Killing needs an explicit `--yes` when there is no terminal (CI, cron, scripts), so a stray `portfox kill` can never stop a process on its own.

`kill --json` also requires `--yes`, even in a terminal. It writes one JSON object with `action`, `port`, `success`, `occupied`, `reason`, `processes`, `otherPorts` and `skippedPids`. `occupied` is `null` when the final port state could not be verified. Failure reasons include `confirmation-required`, `no-target`, `permission-denied`, `still-running`, `still-in-use` and `port-unverified`. In JSON mode, runtime failures return an `error` object with `code` and `message` and exit `1`; invalid arguments return `error.code: "USAGE_ERROR"` and exit `2`.

| Exit code | Meaning |
| --- | --- |
| `0` | Port is free, or the action succeeded |
| `1` | Port is occupied, or the action failed |
| `2` | Usage error |

## How it works

- **macOS** - `lsof`, `ps` for process details (command, parent, user, cwd, start time)
- **Linux** - `lsof`, with `ss` → `netstat` fallbacks; cwd from `/proc/<pid>/cwd`
- **Windows** - `netstat -ano` + `tasklist` (best effort)

If the listening-port scan fails, PortFox reports an error and exits `1` instead of displaying an empty list. Linux tries the next available scanner after a failure; macOS requires `lsof` because BSD `netstat` uses a different format. Process details such as the working directory can still be unavailable due to permissions.

Free-port detection probes `127.0.0.1`, `0.0.0.0`, `::1` and `::`, so ports taken only on IPv6 are never suggested. Bind failures are classified: only `EADDRINUSE` means "busy" - an address the OS refuses to bind (`EADDRNOTAVAIL`, no IPv6 stack) says nothing about the port. Privileged ports and `EPERM` cases are reported with a `sudo` hint instead of a confusing error.

Killing uses SIGTERM first, waits for the process to exit, and offers SIGKILL if it refuses to die.

### Safety

- Before signaling, PortFox re-checks that each PID still holds the port. PIDs that no longer hold it are skipped. This reduces stale-target mistakes but is not an atomic process-identity guarantee: PID reuse or a process changing between the check and the signal can still race.
- Without a terminal, killing is refused unless `--yes` is passed.
- If the target also listens on other ports, PortFox says so before you confirm.

## Development

```sh
git clone https://github.com/merdanturan/portfox
cd portfox
npm test          # node --test - no dependencies to install
```

Layout: `bin/portfox.js` (entry) → `src/cli.js` (commands) → `src/ports.js` (system) → `src/ui.js` (rendering + menu).

### Recording the demo

The README GIF is generated with [vhs](https://github.com/charmbracelet/vhs):

```sh
npm run demo      # writes assets/demo.gif from demo.tape
```

## License

[MIT](./LICENSE)


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

Pick with `↑`/`↓` (or `j`/`k`), press `Enter`. Killing always asks for confirmation first - and in scripts, where nobody can answer, an explicit `--yes` is required. PortFox kills **exactly** the process that holds the port - the one you want gone - and then verifies the port is actually free.

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
```

Killing needs an explicit `--yes` when there is no terminal (CI, cron, scripts), so a stray `portfox kill` can never stop a process on its own.

| Exit code | Meaning |
| --- | --- |
| `0` | Port is free, or the action succeeded |
| `1` | Port is occupied, or the action failed |
| `2` | Usage error |

## How it works

- **macOS** - `lsof`, `ps` for process details (command, parent, user, cwd, start time)
- **Linux** - `lsof`, with `ss` → `netstat` fallbacks; cwd from `/proc/<pid>/cwd`
- **Windows** - `netstat -ano` + `tasklist` (best effort)

Free-port detection probes `127.0.0.1`, `0.0.0.0`, `::1` and `::`, so ports taken only on IPv6 are never suggested. Bind failures are classified: only `EADDRINUSE` means "busy" - an address the OS refuses to bind (`EADDRNOTAVAIL`, no IPv6 stack) says nothing about the port. Privileged ports and `EPERM` cases are reported with a `sudo` hint instead of a confusing error.

Killing uses SIGTERM first, waits for the process to exit, and offers SIGKILL if it refuses to die.

### Safety

- Before signaling, PortFox re-checks that each PID still holds the port. A process that exited in the meantime is skipped - a recycled PID is never killed.
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


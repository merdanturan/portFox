// portfox - terminal rendering, tiny ANSI helpers and the keyboard menu.
// Zero dependencies by design. Keep this file small.
import os from "node:os";

const ESC = "\u001b";

let colorOn =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  Boolean(process.stdout.isTTY);

export function setColorEnabled(value) {
  colorOn = Boolean(value);
}

const paint = (open, close) => (s) =>
  colorOn ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s);

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);
export const cyan = paint(36, 39);
export const gray = paint(90, 39);

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
export const stripAnsi = (s) => String(s).replace(ANSI_RE, "");
export const visibleWidth = (s) => stripAnsi(s).length;
export const padEndVisible = (s, w) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
export const padStartVisible = (s, w) => " ".repeat(Math.max(0, w - visibleWidth(s))) + s;

/* ------------------------------- formatting ------------------------------- */

export function tildify(p) {
  const home = os.homedir();
  if (!p || !home) return p;
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

export function shortenPath(p, max = 46) {
  if (!p || p.length <= max) return p;
  return "…" + p.slice(-(max - 1));
}

// Human-friendly path for display; "-" when unknown or not meaningful.
export function displayPath(p, max = 46) {
  if (!p || p === "/") return "-";
  return shortenPath(tildify(p), max);
}

export function humanizeDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return "a few seconds";
  if (sec < 60) return `${sec} seconds`;
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? "1 minute" : `${min} minutes`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? "1 hour" : `${hr} hours`;
  const days = Math.floor(hr / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

// "[[dd-]hh:]mm:ss" as printed by `ps -o etime=`.
export function parseEtime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let days = 0;
  let rest = raw;
  const dash = raw.indexOf("-");
  if (dash > 0) {
    days = Number(raw.slice(0, dash));
    rest = raw.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n)) || parts.length < 2 || parts.length > 3) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000;
}

/* -------------------------------- rendering ------------------------------- */

export function printHeader() {
  process.stdout.write(`\n  ${bold(cyan("PORTFOX"))}\n\n`);
}

export function printAvailable(port) {
  process.stdout.write(`  ${green("✔")} Port ${yellow(String(port))} is available\n\n`);
}

export function printHint(port) {
  process.stdout.write(
    `  ${dim("Hint:")} ${cyan(`portfox kill ${port} --yes`)} stops it · ${cyan(`portfox ${port} --json`)} for scripts\n\n`
  );
}

const LABEL = 10;

function field(label, value) {
  return `  ${dim(padEndVisible(label, LABEL))} ${value}\n`;
}

export function printSummary(port, result, infos) {
  const out = [];
  out.push(`  Port ${bold(yellow(String(port)))} is occupied\n\n`);

  if (result.reason === "denied") {
    out.push(`  ${yellow("!")} Privileged port - try ${cyan(`sudo portfox ${port}`)}\n\n`);
    process.stdout.write(out.join(""));
    return;
  }

  const info = infos[0] || {};
  out.push(field("Process:", info.name ? bold(info.name) : "-"));
  out.push(field("PID:", info.pid ? String(info.pid) : "-"));
  out.push(field("Project:", displayPath(info.cwd)));
  out.push(
    field("Started:", info.elapsedMs != null ? `${humanizeDuration(info.elapsedMs)} ago` : "-")
  );
  if (infos.length > 1) {
    const others = infos
      .slice(1)
      .map((i) => `${i.name || "?"} (${i.pid || "?"})`)
      .join(", ");
    out.push(field("Others:", others));
  }
  if (!info.pid) {
    out.push(`\n  ${dim("Process details unavailable - try sudo.")}\n`);
  }
  process.stdout.write(out.join(""));
}

function labels(entries, width = LABEL + 1) {
  return entries.map(([k, v]) => `${dim(padEndVisible(k + ":", width))} ${v}`);
}

export function printDetails(info, addresses) {
  const rows = [
    ["Command", info.command || info.name || "-"],
    ["PID", info.pid ? String(info.pid) : "-"],
  ];
  if (info.ppid && info.parentName) rows.push(["Parent", `${info.parentName} (${info.ppid})`]);
  if (info.user) rows.push(["User", info.user]);
  rows.push(["Directory", displayPath(info.cwd, 52)]);
  if (info.startedAt) rows.push(["Started", `${info.startedAt.toLocaleString()} (${humanizeDuration(info.elapsedMs)} ago)`]);
  else if (info.elapsedMs != null) rows.push(["Uptime", humanizeDuration(info.elapsedMs)]);
  if (addresses && addresses.length) rows.push(["Address", addresses.join(", ")]);

  const lines = rows.flatMap(([k, v]) => wrap(labels([[k, v]]), 66));
  process.stdout.write("\n" + frame(lines).map((l) => "  " + l).join("\n") + "\n");
}

function wrap(lines, width) {
  const out = [];
  for (const line of lines) {
    if (visibleWidth(line) <= width) {
      out.push(line);
      continue;
    }
    // Continuation lines are indented under the value column.
    const indent = dim(" ".repeat(LABEL + 2));
    let rest = line;
    let first = true;
    while (visibleWidth(rest) > width) {
      let cut = width;
      const plain = stripAnsi(rest);
      const space = plain.lastIndexOf(" ", width);
      if (space > LABEL + 3) cut = space;
      out.push((first ? "" : indent) + rest.slice(0, cut));
      rest = (first ? rest.slice(cut + 1) : rest.slice(cut));
      first = false;
    }
    out.push((first ? "" : indent) + rest);
  }
  return out;
}

export function frame(lines, pad = 1) {
  const width = Math.max(0, ...lines.map(visibleWidth)) + pad * 2;
  const top = dim("┌" + "─".repeat(width) + "┐");
  const bottom = dim("└" + "─".repeat(width) + "┘");
  const body = lines.map(
    (l) => dim("│") + " ".repeat(pad) + padEndVisible(l, width - pad * 2) + " ".repeat(pad) + dim("│")
  );
  return [top, ...body, bottom];
}

export function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(String(r[i] ?? ""))))
  );
  const line = (cells, style) =>
    "  " +
    cells
      .map((c, i) => style(padEndVisible(String(c ?? ""), widths[i])))
      .join("   ")
      .trimEnd();
  process.stdout.write(line(headers, dim) + "\n");
  for (const row of rows) process.stdout.write(line(row, (s) => s) + "\n");
}

export function startSpinner(text) {
  if (!process.stderr.isTTY) return { stop() {} };
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  let timer = null;
  let painted = false;
  const delay = setTimeout(() => {
    timer = setInterval(() => {
      painted = true;
      process.stderr.write(`\r  ${dim(frames[i++ % frames.length])} ${dim(text)}`);
    }, 80);
  }, 150);
  return {
    stop() {
      clearTimeout(delay);
      if (timer) clearInterval(timer);
      if (painted) process.stderr.write("\r\u001b[2K");
    },
  };
}

export async function withSpinner(text, fn) {
  const spinner = startSpinner(text);
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

/* -------------------------------- keyboard -------------------------------- */

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Single, persistent keyboard pipeline: stdin is resumed once, keys are
// queued, and leftover bytes (e.g. a fast multi-key chunk) are never dropped.
const KEY = { buf: "", waiter: null, escTimer: null, attached: false };

function attachKeys() {
  if (KEY.attached) return;
  KEY.attached = true;
  process.stdin.on("data", (chunk) => {
    if (!KEY.waiter) return; // typed while the app was busy printing; ignore
    KEY.buf += chunk.toString("utf8");
    pumpKeys();
  });
  process.stdin.on("end", () => resolveKey("escape"));
  process.stdin.on("error", () => {});
}

function resolveKey(key) {
  if (!KEY.waiter) return false;
  const waiter = KEY.waiter;
  KEY.waiter = null;
  if (KEY.escTimer) {
    clearTimeout(KEY.escTimer);
    KEY.escTimer = null;
  }
  waiter(key);
  return true;
}

function consumeKey(buf) {
  if (buf.startsWith(`${ESC}[A`) || buf.startsWith(`${ESC}OA`)) return { key: "up", size: 3 };
  if (buf.startsWith(`${ESC}[B`) || buf.startsWith(`${ESC}OB`)) return { key: "down", size: 3 };
  if (buf.startsWith(ESC)) return { key: "escape", size: 1 };
  const ch = buf[0];
  if (ch === "\r" || ch === "\n") return { key: "enter", size: 1 };
  if (ch === "\u0003") return { key: "ctrl-c", size: 1 };
  if (ch === " ") return { key: "space", size: 1 };
  return { key: decodeChar(ch), size: 1 };
}

function pumpKeys() {
  for (;;) {
    if (!KEY.waiter || !KEY.buf) return;
    if (KEY.buf === ESC) {
      // Could be a lone Escape or the start of an arrow key; wait briefly.
      if (!KEY.escTimer) {
        KEY.escTimer = setTimeout(() => {
          KEY.escTimer = null;
          KEY.buf = "";
          resolveKey("escape");
        }, 50);
      }
      return;
    }
    const { key, size } = consumeKey(KEY.buf);
    KEY.buf = KEY.buf.slice(size);
    if (resolveKey(key)) return;
  }
}

function readKey() {
  attachKeys();
  if (process.stdin.readableEnded) return Promise.resolve("escape");
  return new Promise((resolve) => {
    KEY.waiter = resolve;
    pumpKeys();
  });
}

function decodeChar(ch) {
  const c = ch.toLowerCase();
  if (c === "k") return "up";
  if (c === "j") return "down";
  return "qyn".includes(c) ? c : "other";
}

async function withRaw(fn) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return null;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await fn();
  } finally {
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
  }
}

export function exitCleanly(code) {
  try {
    process.stdin.setRawMode(false);
  } catch {}
  process.exit(code);
}

export async function selectMenu(items) {
  if (!isInteractive()) return null;
  return withRaw(async () => {
    const width = Math.max(...items.map(visibleWidth));
    let selected = 0;
    let printed = 0;
    const clear = () => {
      if (printed) process.stdout.write(`\u001b[${printed}A\r\u001b[J`);
      printed = 0;
    };
    for (;;) {
      if (printed) clear();
      const lines = frame(
        items.map((item, i) => {
          const marker = i === selected ? cyan("❯") : " ";
          return `${marker} ${i === selected ? bold(item) : item}`;
        })
      ).map((l) => "  " + l);
      process.stdout.write(lines.join("\n") + "\n");
      printed = lines.length;

      const key = await readKey();
      if (key === "up") selected = (selected - 1 + items.length) % items.length;
      else if (key === "down") selected = (selected + 1) % items.length;
      else if (key === "enter" || key === "space") {
        clear();
        return selected;
      } else if (key === "ctrl-c") exitCleanly(130);
      else if (key === "escape" || key === "q") {
        clear();
        return null;
      }
    }
  });
}

export async function confirm(message, { defaultYes = false } = {}) {
  if (!isInteractive()) return defaultYes;
  return withRaw(async () => {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    process.stdout.write(`  ${yellow("?")} ${message} ${dim(suffix)} `);
    let answer = defaultYes;
    for (;;) {
      const key = await readKey();
      if (key === "y") answer = true;
      else if (key === "n") answer = false;
      else if (key === "enter") answer = defaultYes;
      else if (key === "escape" || key === "q") answer = false;
      else if (key === "ctrl-c") exitCleanly(130);
      else continue;
      break;
    }
    process.stdout.write(`\r\u001b[2K  ${yellow("?")} ${message} ${answer ? green("yes") : dim("no")}\n`);
    return answer;
  });
}

export async function pressAnyKey(message) {
  if (!isInteractive()) return;
  return withRaw(async () => {
    process.stdout.write(`  ${dim(message)}`);
    await readKey();
    process.stdout.write("\r\u001b[2K");
  });
}

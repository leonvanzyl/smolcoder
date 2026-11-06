// Update notices and the one-step updater, shared by the terminal UI and the
// web hub. Nothing here ever reaches the model's context: it only feeds
// notices, the /update dialog and the restart.
//
//   check   the registry's "latest" for smolcoder, at most every 12 hours,
//           cached in ~/.smolcoder/update-check.json; silent on any failure
//   detect  how this copy was installed (npm / pnpm / yarn / bun global,
//           a source checkout, npx, or something else)
//   run     the package manager's own update command as a child process,
//           streaming its output, then read the installed package.json
//   restart the same CLI again with the same arguments (TUI: plus
//           --resume <session>), see index.ts and web/hub.ts

import { spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, loadConfig, updateConfig } from "./config";
import { tryFetchJson } from "./util";

export const PACKAGE_NAME = "smolcoder";
/** This copy's package folder (dist/.. — the same in a checkout and an install). */
export const PACKAGE_DIR = path.resolve(__dirname, "..");
export const CURRENT_VERSION: string = require("../package.json").version;
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 3000;
const CACHE_FILE = "update-check.json";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** SMOLCODER_REGISTRY points tests (or a mirror) at another registry. */
export function registryBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SMOLCODER_REGISTRY || DEFAULT_REGISTRY).trim().replace(/\/+$/, "");
}

export function releaseUrl(version: string): string {
  return `https://github.com/leonvanzyl/smolcoder/releases/tag/v${version}`;
}

// ---- versions --------------------------------------------------------------

interface Version {
  main: [number, number, number];
  pre: (string | number)[];
}

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

export function isPrerelease(v: string): boolean {
  return !!parseVersion(v)?.pre.length;
}

/** Semver precedence: <0 when a is older, 0 when equal, >0 when newer.
 * Unparseable versions compare equal (never offered). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] - y.main[i];
  // A release outranks its prereleases.
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1; // numeric identifiers sort first
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `latest` is worth offering to someone on `current`. Prereleases
 * are only offered to people already on a prerelease. */
export function isNewer(latest: string, current: string): boolean {
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  if (isPrerelease(latest) && !isPrerelease(current)) return false;
  return compareVersions(latest, current) > 0;
}

// ---- the check -------------------------------------------------------------

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  checkedAt: number;
}

export function readUpdateCache(dataDir = DATA_DIR): UpdateCache | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, CACHE_FILE), "utf8"));
    if (c && typeof c.checkedAt === "number" && typeof c.latest === "string" && parseVersion(c.latest)) return c;
  } catch {
    /* none yet */
  }
  return null;
}

function writeUpdateCache(dataDir: string, c: UpdateCache): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, CACHE_FILE), JSON.stringify(c));
  } catch {
    /* the next start just checks again */
  }
}

/** Is the cached answer recent enough to skip the registry? */
export function cacheFresh(c: UpdateCache | null, now = Date.now(), interval = CHECK_INTERVAL_MS): c is UpdateCache {
  return !!c && c.checkedAt <= now && now - c.checkedAt < interval;
}

/** The setting: on unless `updateCheck: false` was chosen. */
export function updateChecksSetting(): boolean {
  return loadConfig().updateCheck !== false;
}

export function setUpdateChecks(on: boolean): void {
  updateConfig({ updateCheck: on });
}

/** Whether to check by itself: the setting, and never in CI. Headless runs
 * and a terminal that is not a TTY are ruled out by the callers. */
export function autoCheckAllowed(env: NodeJS.ProcessEnv = process.env, setting = updateChecksSetting()): boolean {
  if (!setting) return false;
  const ci = String(env.CI ?? "").toLowerCase();
  if (ci && ci !== "0" && ci !== "false") return false;
  if (env.NO_UPDATE_NOTIFIER) return false;
  return true;
}

/** The registry's latest version, or null (3s timeout, any failure). */
export async function fetchLatestVersion(env: NodeJS.ProcessEnv = process.env, timeoutMs = CHECK_TIMEOUT_MS): Promise<string | null> {
  const r = await tryFetchJson(`${registryBase(env)}/${PACKAGE_NAME}/latest`, { headers: { accept: "application/json" } }, timeoutMs);
  const v = typeof r?.version === "string" ? r.version.trim() : "";
  return parseVersion(v) ? v : null;
}

export interface CheckOptions {
  dataDir?: string;
  current?: string;
  /** Ask the registry even when the cache is fresh (/update). */
  force?: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
  fetchLatest?: () => Promise<string | null>;
}

/** Cached for 12 hours. Null when nothing is known (offline, first run). */
export async function checkForUpdate(o: CheckOptions = {}): Promise<UpdateInfo | null> {
  const dataDir = o.dataDir ?? DATA_DIR;
  const current = o.current ?? CURRENT_VERSION;
  const now = o.now ?? Date.now();
  const cached = readUpdateCache(dataDir);
  const info = (c: UpdateCache): UpdateInfo => ({ current, latest: c.latest, newer: isNewer(c.latest, current), checkedAt: c.checkedAt });
  if (!o.force && cacheFresh(cached, now)) return info(cached);
  let latest: string | null = null;
  try {
    latest = await (o.fetchLatest ?? (() => fetchLatestVersion(o.env)))();
  } catch {
    latest = null;
  }
  if (!latest) return cached ? info(cached) : null;
  const fresh = { checkedAt: now, latest };
  writeUpdateCache(dataDir, fresh);
  return info(fresh);
}

// ---- how this copy was installed --------------------------------------------

export type InstallKind = "npm" | "pnpm" | "yarn" | "bun" | "source" | "npx" | "unknown";

export interface UpdateCommand {
  file: string;
  args: string[];
  /** As the user would type it. */
  display: string;
}

export interface InstallInfo {
  kind: InstallKind;
  /** e.g. "npm · global". */
  label: string;
  packageDir: string;
  /** npm: the global prefix when it is not npm's default one. */
  prefix?: string;
  /** Known managers: what /update runs. */
  command?: UpdateCommand;
  /** The package.json read after the update; its folder holds the new
   * dist/index.js the restart launches. */
  manifest: string;
  /** When /update does not run anything itself: what to do instead. */
  manual?: string;
  /** The same, split for display: why, and the command to run yourself. */
  reason?: string;
  manualCommand?: string;
}

export interface DetectOptions {
  packageDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `npm root -g` (null when npm could not say). */
  npmRoot?: string | null;
  exists?: (p: string) => boolean;
}

function quoteArg(a: string, win: boolean): string {
  if (/^[\w@.,:/\\=+-]+$/.test(a)) return a;
  return win ? `"${a.replace(/"/g, '""')}"` : `'${a.replace(/'/g, `'\\''`)}'`;
}

function cmd(file: string, args: string[], win: boolean): UpdateCommand {
  return { file, args, display: [file, ...args].map((a) => quoteArg(a, win)).join(" ") };
}

const SPEC = `${PACKAGE_NAME}@latest`;

function manualOf(reason: string, command: string, where?: string): { manual: string; reason: string; manualCommand: string } {
  return { manual: `${reason}: ${command}${where ? ` (${where})` : ""}`, reason: where ? `${reason} (${where})` : reason, manualCommand: command };
}

/** Work out how this copy was installed from where it lives. Pure (the
 * filesystem is only asked through `exists`), so tests feed fake paths. */
export function detectInstall(o: DetectOptions = {}): InstallInfo {
  const platform = o.platform ?? process.platform;
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const env = o.env ?? process.env;
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const dir = P.resolve(o.packageDir ?? PACKAGE_DIR);
  const manifest = P.join(dir, "package.json");
  // Compare paths with forward slashes, case-insensitively on Windows.
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return win ? s.toLowerCase() : s;
  };
  const n = norm(dir) + "/";
  const agent = String(env.npm_config_user_agent ?? "");
  const base = { packageDir: dir, manifest };

  // A git checkout (npm link points the global folder at one), or a copy
  // that still has its sources: never run a package manager over it.
  if (exists(P.join(dir, ".git")) || exists(P.join(dir, "src", "index.ts"))) {
    return { ...base, kind: "source", label: "source checkout", ...manualOf("Running from source", "git pull && npm run build", `in ${dir}`) };
  }

  // One-off runners keep the package in a cache folder.
  if (/\/_npx\//.test(n) || env.npm_command === "exec") {
    return { ...base, kind: "npx", label: "npx", ...manualOf("npx runs whichever version you ask for", `npx ${SPEC}`) };
  }
  if (/\/pnpm\/dlx\//.test(n) || /\/dlx-\d+\//.test(n)) {
    return { ...base, kind: "npx", label: "pnpm dlx", ...manualOf("pnpm dlx runs whichever version you ask for", `pnpm dlx ${SPEC}`) };
  }
  if (/\/bunx-[^/]*\//.test(n)) {
    return { ...base, kind: "npx", label: "bunx", ...manualOf("bunx runs whichever version you ask for", `bunx ${SPEC}`) };
  }

  // pnpm keeps globals in <pnpm home>/global/<n>/node_modules, the package
  // itself in .pnpm/<name>@<version>/node_modules/<name>: read the link.
  if (/\/pnpm\/global\//.test(n) || (agent.startsWith("pnpm/") && /\/node_modules\/\.pnpm\//.test(n))) {
    const i = n.indexOf("/node_modules/.pnpm/");
    const root = i >= 0 ? dir.slice(0, i) : P.dirname(P.dirname(dir));
    const m = i >= 0 ? P.join(root, "node_modules", PACKAGE_NAME, "package.json") : manifest;
    return { ...base, manifest: m, kind: "pnpm", label: "pnpm · global", command: cmd("pnpm", ["add", "-g", SPEC], win) };
  }
  if (/\/yarn\/(?:data\/)?global\/node_modules\//.test(n) || /\/\.config\/yarn\/global\//.test(n)) {
    return { ...base, kind: "yarn", label: "yarn · global", command: cmd("yarn", ["global", "add", SPEC], win) };
  }
  if (/\/\.bun\/install\/global\/node_modules\//.test(n)) {
    return { ...base, kind: "bun", label: "bun · global", command: cmd("bun", ["add", "-g", SPEC], win) };
  }

  const parent = P.dirname(dir);
  if (o.npmRoot && norm(P.resolve(o.npmRoot)) === norm(parent)) {
    return { ...base, kind: "npm", label: "npm · global", command: cmd("npm", ["install", "-g", SPEC], win) };
  }
  if (P.basename(parent).toLowerCase() === "node_modules") {
    // npm's global layout: <prefix>/node_modules/<pkg> plus <prefix>/smol.cmd
    // on Windows, <prefix>/lib/node_modules/<pkg> plus <prefix>/bin/smol elsewhere.
    const lib = P.dirname(parent);
    const prefix = win ? lib : P.basename(lib) === "lib" ? P.dirname(lib) : null;
    const shims = prefix ? (win ? ["smol.cmd", "smolcoder.cmd"].map((s) => P.join(prefix, s)) : ["smol", "smolcoder"].map((s) => P.join(prefix, "bin", s))) : [];
    if (prefix && shims.some(exists)) {
      return { ...base, kind: "npm", label: "npm · global", prefix, command: cmd("npm", ["install", "-g", "--prefix", prefix, SPEC], win) };
    }
    if (exists(P.join(lib, "package.json"))) {
      return { ...base, kind: "unknown", label: "project dependency", ...manualOf(`smolcoder is a dependency of ${lib}`, `npm install ${SPEC}`, "in that project") };
    }
  }
  return {
    ...base,
    kind: "unknown",
    label: "unknown",
    ...manualOf("Update it the way you installed it, for example", `npm install -g ${SPEC}`),
  };
}

/** `npm root -g`, or null (no npm, or it took longer than 5s). */
export function npmGlobalRoot(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnCommand(cmd("npm", ["root", "-g"], process.platform === "win32"), { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 5000);
    timer.unref?.();
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && out.trim() ? out.trim().split(/\r?\n/).pop()!.trim() : null));
  });
}

/** detectInstall for this copy, asking npm for its global root first. */
export async function detectThisInstall(env: NodeJS.ProcessEnv = process.env): Promise<InstallInfo> {
  const first = detectInstall({ env });
  if (first.kind !== "unknown" && first.kind !== "npm") return first;
  return detectInstall({ env, npmRoot: await npmGlobalRoot(env) });
}

// ---- running the update --------------------------------------------------------

/** Windows runs npm/pnpm/yarn through their .cmd shims, which need a shell
 * (spawning a .cmd directly is refused since Node 18.20). */
function spawnCommand(c: UpdateCommand, opts: SpawnOptions) {
  if (process.platform === "win32") return spawn(c.display, [], { ...opts, shell: true, windowsHide: true });
  return spawn(c.file, c.args, opts);
}

export interface RunResult {
  ok: boolean;
  /** The version the package.json says after the run. */
  version: string | null;
  /** One line for the UI; failures may carry a command on later lines. */
  message: string;
  /** The package manager could not write where the package lives. */
  permission?: boolean;
  code?: number | null;
}

export interface RunOptions {
  /** The version the registry announced; the run must reach at least it. */
  latest?: string;
  onOutput?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests run a fake package manager. */
  spawnFn?: (c: UpdateCommand, opts: SpawnOptions) => ReturnType<typeof spawn>;
  /** Tests skip the writability check. */
  writable?: (dir: string) => boolean;
  timeoutMs?: number;
}

export function readInstalledVersion(manifest: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof v === "string" && parseVersion(v) ? v : null;
  } catch {
    return null;
  }
}

function canWrite(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** What to say when the package manager may not write the install folder. */
export function permissionMessage(info: InstallInfo, platform: NodeJS.Platform = process.platform): string {
  const command = info.command?.display ?? `npm install -g ${SPEC}`;
  const where = info.prefix ?? path.dirname(info.packageDir);
  if (platform === "win32") {
    return `Windows would not let ${info.command?.file ?? "npm"} replace the files in ${where}.\nClose other smol windows and try again, or run this in a terminal opened as Administrator:\n  ${command}`;
  }
  return `${info.command?.file ?? "npm"} cannot write to ${where}. Run it yourself with sudo:\n  sudo ${command}\nor give npm a folder you own: npm config set prefix ~/.npm-global (then add ~/.npm-global/bin to PATH)`;
}

const PERMISSION_RE = /\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted/i;

/** Run the update command, streaming its output, then check the installed
 * package.json. Never throws. */
export function runUpdate(info: InstallInfo, o: RunOptions = {}): Promise<RunResult> {
  const platform = o.platform ?? process.platform;
  if (!info.command) return Promise.resolve({ ok: false, version: readInstalledVersion(info.manifest), message: info.manual ?? "This copy cannot update itself." });
  const before = readInstalledVersion(info.manifest);
  if (platform !== "win32" && !(o.writable ?? canWrite)(path.dirname(info.packageDir))) {
    return Promise.resolve({ ok: false, version: before, permission: true, message: permissionMessage(info, platform) });
  }
  const base = o.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
  // The hub's handoff must not leak into the package manager.
  delete env.SMOLCODER_WEB_HANDOFF;
  delete env.SMOLCODER_UPDATED_FROM;
  if (base.SMOLCODER_REGISTRY) {
    env.npm_config_registry = registryBase(base) + "/";
    env.BUN_CONFIG_REGISTRY = registryBase(base) + "/";
  }
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const emit = (d: Buffer | string) => {
      const s = String(d);
      output = (output + s).slice(-20_000);
      o.onOutput?.(s);
    };
    o.onOutput?.(`$ ${info.command!.display}\n`);
    let child: ReturnType<typeof spawn>;
    try {
      child = (o.spawnFn ?? spawnCommand)(info.command!, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      return finish({ ok: false, version: before, message: `Could not start ${info.command!.file}: ${err?.message ?? err}\nRun it yourself:\n  ${info.command!.display}` });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, version: readInstalledVersion(info.manifest), message: `${info.command!.file} took longer than ${Math.round((o.timeoutMs ?? 600_000) / 60000)} minutes and was stopped.\nRun it yourself:\n  ${info.command!.display}` });
    }, o.timeoutMs ?? 600_000);
    timer.unref?.();
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.on("error", (err: any) =>
      finish({ ok: false, version: before, message: `Could not run ${info.command!.file}${err?.code === "ENOENT" ? " (not found on PATH)" : `: ${err?.message ?? err}`}.\nRun it yourself:\n  ${info.command!.display}` })
    );
    child.on("close", (code) => {
      const version = readInstalledVersion(info.manifest);
      if (code === 0 && version && (o.latest ? compareVersions(version, o.latest) >= 0 : version !== before)) {
        return finish({ ok: true, code, version, message: `Updated to ${version}` });
      }
      if (PERMISSION_RE.test(output)) return finish({ ok: false, code, version, permission: true, message: permissionMessage(info, platform) });
      if (code === 0) {
        return finish({ ok: false, code, version, message: `${info.command!.file} finished, but ${info.manifest} still says ${version ?? "nothing readable"}.\nRun it yourself:\n  ${info.command!.display}` });
      }
      finish({ ok: false, code, version, message: `${info.command!.file} exited with code ${code}.\nRun it yourself:\n  ${info.command!.display}` });
    });
  });
}

// ---- restarting -------------------------------------------------------------------

/** The CLI arguments for the restarted copy: the same ones without an
 * earlier --resume, then --resume <id> when there is a session to reopen.
 * `mode` is the session's current mode (shift+tab may have changed it since
 * launch); it replaces any --mode given on the command line. */
export function restartArgs(argv: string[], sessionId: string | null, mode?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" || (mode && (argv[i] === "--mode" || argv[i] === "-m"))) {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  if (mode) out.push("--mode", mode);
  if (sessionId) out.push("--resume", sessionId);
  return out;
}

export interface RelaunchOptions {
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  exit?: (code: number) => void;
  onError?: (err: Error) => void;
}

/** Hand this terminal to a new copy: it inherits stdin/stdout/stderr, this
 * process waits and then exits with its code. The caller has restored the
 * terminal (left the alternate screen, raw mode off) first. */
export function relaunch(entry: string, args: string[], o: RelaunchOptions = {}) {
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const child = (o.spawnFn ?? spawn)(process.execPath, [...process.execArgv, entry, ...args], {
    stdio: "inherit",
    env: { ...(o.env ?? process.env), SMOLCODER_UPDATED_FROM: CURRENT_VERSION },
  });
  child.on("exit", (code, signal) => exit(code ?? (signal ? 1 : 0)));
  child.on("error", (err) => {
    if (o.onError) o.onError(err);
    else process.stderr.write(`\nCould not restart smolcoder: ${err.message}\nRun smol again to use the new version.\n`);
    exit(1);
  });
  return child;
}

/** The entry point to launch after an update: the updated package's
 * dist/index.js (pnpm moves it to a new folder), else this one. */
export function restartEntry(info: InstallInfo | null, fallback = process.argv[1]): string {
  if (info) {
    const entry = path.join(path.dirname(info.manifest), "dist", "index.js");
    if (fs.existsSync(entry)) return entry;
  }
  return fallback;
}

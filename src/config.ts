// User config (~/.smolcoder.json) and the data directory (~/.smolcoder/) that
// holds saved web sessions and the workspace list. Shared by the CLI entry
// point, the session loop and the web hub.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Effort } from "./providers/types";
import { Mode } from "./tools/index";

// SMOLCODER_CONFIG points tests at a scratch file so they never touch the
// real one.
export const CONFIG_PATH = process.env.SMOLCODER_CONFIG || path.join(os.homedir(), ".smolcoder.json");
export const DATA_DIR = path.join(os.homedir(), ".smolcoder");

/** Another machine that serves models, added from the model picker. */
export interface SavedHost {
  /** What to connect to: a bare host ("192.168.1.50", "gpu-box.local") means
   * "look for Ollama and LM Studio on their usual ports"; a full URL or
   * host:port names one server exactly. */
  address: string;
  /** Display name; defaults to the host part of the address. */
  name?: string;
}

export interface Config {
  lastModel?: string;
  /** Server the last model ran on — the same model id can exist on several machines. */
  lastModelUrl?: string;
  lastMode?: Mode;
  effort?: Effort | null;
  hosts?: SavedHost[];
  /** API keys by server URL, for servers that require one (oMLX, MTPLX). */
  keys?: Record<string, string>;
  /** Web search and page reading for the model. Off unless turned on. */
  web?: { enabled?: boolean; searxng?: string };
}

export function loadConfig(): Config {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // Never let bypass be inherited implicitly from a past session — a single
    // shift+tab into it would otherwise silently persist unattended, unchecked
    // command execution into every later run, including headless -p in CI.
    // Requires an explicit flag (-m bypass / --bypass) each time. Old configs
    // saved "write"/"yolo" under the previous mode names.
    if (cfg.lastMode === "write") cfg.lastMode = "edit";
    if (cfg.lastMode === "yolo" || cfg.lastMode === "bypass") cfg.lastMode = "edit";
    cfg.hosts = Array.isArray(cfg.hosts)
      ? cfg.hosts
          .filter((h: any) => h && typeof h.address === "string" && h.address.trim())
          .map((h: any) => ({
            address: h.address.trim(),
            ...(typeof h.name === "string" && h.name.trim() ? { name: h.name.trim() } : {}),
          }))
      : [];
    cfg.keys = Object.fromEntries(
      Object.entries(cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {}).filter(([u, v]) => /^https?:\/\//.test(u) && typeof v === "string" && v)
    ) as Record<string, string>;
    return cfg;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // It can hold API keys: private to its owner, also when it already existed.
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* non-fatal */
  }
}

/** Change some settings and keep the rest. Re-reads the file first: several
 * web sessions share it, and each one only knows about its own fields. */
export function updateConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/** The API key saved for the server at `base`, if any. */
export function savedKey(base: string): string | undefined {
  return loadConfig().keys?.[base];
}

/** Save a key for these servers, or forget theirs when `key` is empty. */
export function setKeys(bases: string[], key?: string): void {
  const keys = { ...(loadConfig().keys ?? {}) };
  for (const base of bases) {
    if (key) keys[base] = key;
    else delete keys[base];
  }
  updateConfig({ keys });
}

export const DEFAULT_SEARXNG = "http://127.0.0.1:8888";

/** Web access as saved, with junk falling back to off and the default address. */
export function webSettings(cfg: Config = loadConfig()): { enabled: boolean; searxng: string } {
  const w = cfg.web && typeof cfg.web === "object" ? cfg.web : {};
  const url = typeof w.searxng === "string" && /^https?:\/\/[^\s/?#]+/.test(w.searxng) ? w.searxng.replace(/\/+$/, "") : DEFAULT_SEARXNG;
  return { enabled: w.enabled === true, searxng: url };
}

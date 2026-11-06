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
   * "look for every model server on its usual port"; a full URL or
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
  /** Models picked lately, newest first (at most RECENT_LIMIT). */
  recentModels?: ModelRef[];
  /** Models starred in the model picker (ctrl+f / the star button). */
  favoriteModels?: ModelRef[];
  /** Reasoning effort chosen per model id; null means "the model's default". */
  effortByModel?: Record<string, Effort | null>;
  /** false: never look for a new smolcoder version by itself (/update-check). */
  updateCheck?: boolean;
}

/** One model on one server: the same id can be served by several machines. */
export interface ModelRef {
  id: string;
  baseUrl: string;
  /** Backend kind when known, so the model can be found again without a rescan. */
  backend?: string;
}

export const RECENT_LIMIT = 10;
const EFFORTS = ["off", "low", "medium", "high"];

function modelRefs(v: unknown): ModelRef[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const r of v) {
    if (!r || typeof r.id !== "string" || !r.id || typeof r.baseUrl !== "string") continue;
    const key = `${r.baseUrl}|${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, baseUrl: r.baseUrl, ...(typeof r.backend === "string" && r.backend ? { backend: r.backend } : {}) });
  }
  return out;
}

export function sameModel(a: { id: string; baseUrl: string }, b: { id: string; baseUrl: string }): boolean {
  return a.id === b.id && a.baseUrl === b.baseUrl;
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
    cfg.recentModels = modelRefs(cfg.recentModels).slice(0, RECENT_LIMIT);
    cfg.favoriteModels = modelRefs(cfg.favoriteModels);
    cfg.effortByModel = Object.fromEntries(
      Object.entries(cfg.effortByModel && typeof cfg.effortByModel === "object" ? cfg.effortByModel : {}).filter(
        ([id, e]) => id && (e === null || EFFORTS.includes(e as string))
      )
    ) as Record<string, Effort | null>;
    if (typeof cfg.updateCheck !== "boolean") delete cfg.updateCheck;
    return cfg;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  try {
    // It can hold API keys: private to its owner, also when it already
    // existed — and made so before a key is written into it, not after.
    if (fs.existsSync(CONFIG_PATH)) fs.chmodSync(CONFIG_PATH, 0o600);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
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

/** Put a model at the front of the recent list (kept to RECENT_LIMIT). */
export function recordRecentModel(m: ModelRef): ModelRef[] {
  const ref: ModelRef = { id: m.id, baseUrl: m.baseUrl, ...(m.backend ? { backend: m.backend } : {}) };
  const recentModels = [ref, ...(loadConfig().recentModels ?? []).filter((r) => !sameModel(r, ref))].slice(0, RECENT_LIMIT);
  updateConfig({ recentModels });
  return recentModels;
}

/** Star or unstar a model; returns whether it is now a favorite. */
export function toggleFavoriteModel(m: ModelRef): boolean {
  const favs = loadConfig().favoriteModels ?? [];
  const had = favs.some((f) => sameModel(f, m));
  const favoriteModels = had ? favs.filter((f) => !sameModel(f, m)) : [{ id: m.id, baseUrl: m.baseUrl, ...(m.backend ? { backend: m.backend } : {}) }, ...favs];
  updateConfig({ favoriteModels });
  return !had;
}

/** Remember the reasoning effort for a model id. */
export function saveModelEffort(modelId: string, effort: Effort | null): void {
  updateConfig({ effortByModel: { ...(loadConfig().effortByModel ?? {}), [modelId]: effort } });
}

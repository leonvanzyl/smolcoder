// What the web settings page shows and changes: the model servers that
// answer (and which wait for an API key), keys per server, network
// machines, and the defaults a new session starts with. Nothing here is new
// state — it is the same config the pickers and flags already use, in one
// place. API keys go in and never come back out.

import { Config, loadConfig, savedKey, setKeys, updateConfig, webSettings } from "./config";
import { detectServers, identifyServer, ServerInfo } from "./detect";
import { hostLabel, hostUrls, removeHost, renameHost } from "./hosts";
import { addMachine, AddResult, BACKEND_NAMES, KEYED } from "./network";

export { addMachine };
export type { AddResult };

export interface ServerRow {
  backend: string;
  name: string;
  baseUrl: string;
  /** Network machine serving it; absent for this computer. */
  host?: string;
  models: number;
  /** Can require an API key (oMLX, MTPLX). */
  keyed: boolean;
  hasKey: boolean;
  /** Answers, but lists no models without a key. */
  locked: boolean;
}

export interface SettingsView {
  servers: ServerRow[];
  hosts: { address: string; name?: string }[];
  models: { id: string; baseUrl: string; backend: string; host?: string }[];
  defaults: { model?: string; modelUrl?: string; effort: string | null; mode: string };
}

const EFFORTS = ["off", "low", "medium", "high"];
// Bypass is never a default: it is chosen per session, on purpose.
const MODES = ["ro", "edit"];

function row(s: ServerInfo): ServerRow {
  const keyed = KEYED.includes(s.backend);
  return {
    backend: s.backend,
    name: BACKEND_NAMES[s.backend],
    baseUrl: s.baseUrl,
    ...(s.host ? { host: s.host } : {}),
    models: s.models.length,
    keyed,
    hasKey: !!savedKey(s.baseUrl),
    locked: keyed && s.models.length === 0,
  };
}

export async function settingsView(detect = () => detectServers({ hosts: loadConfig().hosts })): Promise<SettingsView> {
  const servers = await detect();
  const cfg = loadConfig();
  return {
    servers: servers.map(row),
    hosts: (cfg.hosts ?? []).map((h) => ({ address: h.address, ...(h.name ? { name: h.name } : {}) })),
    models: servers.flatMap((s) => s.models.map((m) => ({ id: m.id, baseUrl: m.baseUrl, backend: m.backend, ...(m.host ? { host: m.host } : {}) }))),
    defaults: { model: cfg.lastModel, modelUrl: cfg.lastModelUrl, effort: cfg.effort ?? null, mode: cfg.lastMode ?? "edit" },
  };
}

const SERVER_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;

/** Save (or with no key, forget) the key for one server. A key is kept only
 * after the server accepts it. */
export async function setServerKey(
  baseUrl: string,
  key: string | null
): Promise<{ ok: true; server: ServerRow | null } | { ok: false; error: string }> {
  if (!SERVER_URL.test(baseUrl)) throw new Error("not a server address");
  const host = (loadConfig().hosts ?? []).find((h) => hostUrls(h).includes(baseUrl));
  const label = (info: ServerInfo) => row({ ...info, ...(host ? { host: hostLabel(host) } : {}) });
  const trimmed = (key ?? "").trim().slice(0, 500);
  if (!trimmed) {
    setKeys([baseUrl]);
    const info = await identifyServer(baseUrl, 4000);
    return { ok: true, server: info ? label(info) : null };
  }
  const info = await identifyServer(baseUrl, 4000, trimmed);
  if (!info) return { ok: false, error: `Nothing answered at ${baseUrl}.` };
  if (KEYED.includes(info.backend) && !info.models.length)
    return { ok: false, error: `${BACKEND_NAMES[info.backend]} at ${baseUrl} did not accept that API key.` };
  setKeys([baseUrl], trimmed);
  return { ok: true, server: label(info) };
}

export function removeMachine(address: string): void {
  const hosts = loadConfig().hosts ?? [];
  const host = hosts.find((h) => h.address === address) ?? { address };
  updateConfig({ hosts: removeHost(hosts, address) });
  setKeys(hostUrls(host));
}

export function renameMachine(address: string, name: string): void {
  const clean = String(name ?? "").trim().slice(0, 80);
  if (!clean) throw new Error("a name is required");
  updateConfig({ hosts: renameHost(loadConfig().hosts ?? [], address, clean) });
}

/** The model, effort and mode a new session starts with. Only the fields
 * given change. */
export function saveDefaults(d: { model?: string; modelUrl?: string; effort?: string | null; mode?: string }): void {
  const patch: Partial<Config> = {};
  if (d.model !== undefined) patch.lastModel = String(d.model).slice(0, 200);
  if (d.modelUrl !== undefined) {
    if (!SERVER_URL.test(d.modelUrl)) throw new Error("not a server address");
    patch.lastModelUrl = d.modelUrl;
  }
  if (d.effort !== undefined) {
    if (d.effort !== null && !EFFORTS.includes(d.effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")} or default`);
    patch.effort = d.effort as Config["effort"];
  }
  if (d.mode !== undefined) {
    if (!MODES.includes(d.mode)) throw new Error(`mode must be ${MODES.join(" or ")}`);
    patch.lastMode = d.mode as Config["lastMode"];
  }
  updateConfig(patch);
}

export type SearxngStatus = "ok" | "json-off" | "unreachable";

/** Whether a SearXNG answers at `base` with the JSON the model needs. */
export async function searxngStatus(base: string): Promise<SearxngStatus> {
  try {
    const res = await fetch(`${base}/search?q=smolcoder&format=json`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 403) return "json-off";
    return res.ok && Array.isArray(((await res.json().catch(() => null)) as any)?.results) ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function webView(): Promise<{ enabled: boolean; searxng: string; status: SearxngStatus }> {
  const w = webSettings();
  return { ...w, status: await searxngStatus(w.searxng) };
}

/** Turn web access on or off and/or change the SearXNG address. Only the
 * fields given change. */
export async function saveWeb(d: { enabled?: boolean; searxng?: string }): Promise<{ enabled: boolean; searxng: string; status: SearxngStatus }> {
  const now = webSettings();
  let searxng = now.searxng;
  if (d.searxng !== undefined) {
    const url = String(d.searxng).trim().replace(/\/+$/, "");
    if (!SERVER_URL.test(url)) throw new Error("not a server address — for example http://127.0.0.1:8888");
    searxng = url;
  }
  const enabled = d.enabled === undefined ? now.enabled : d.enabled === true;
  updateConfig({ web: { enabled, searxng } });
  return webView();
}

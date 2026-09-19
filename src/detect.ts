// Zero-config backend detection. Build a list of places a model server could
// be — loopback on the usual ports, $OLLAMA_HOST, the port LM Studio says it
// serves on, ports published by Docker containers, the host machine when we
// run inside WSL or a container, and network hosts the user added — then ask
// each one what it is. The ANSWER decides the backend, never the port, so
// Ollama and LM Studio are found the same way wherever they listen.
//
// The two backends are asymmetric on context windows:
//   - Ollama: WE choose the window (num_ctx is a per-request option). Read the
//     model's true maximum from /api/show and set num_ctx explicitly, because
//     Ollama's defaults vary by version and silently truncate the prompt.
//   - LM Studio: the window is fixed when the model is loaded in LM Studio's
//     UI. We READ it from /api/v1/models (or the older /api/v0) and adapt.
//     The same endpoint tells us which reasoning levels the model supports
//     and which one it defaults to — that default is often the MAXIMUM.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SavedHost } from "./config";
import { hostLabel, hostUrls, LMSTUDIO_PORT, OLLAMA_PORT, OMLX_PORT } from "./hosts";
import { isMtplxHealth, mtplxHeaders, parseMtplxModels, readMtplxPort } from "./mtplx";
import { isOmlxHealth, omlxHeaders, parseOmlxModels, readOmlxSettings } from "./omlx";
import { ReasoningInfo } from "./providers/lmstudio";
import { probeJson, tryFetchJson } from "./util";

export type BackendKind = "ollama" | "lmstudio" | "omlx" | "mtplx";

export interface DetectedModel {
  id: string;
  backend: BackendKind;
  baseUrl: string;
  /** Name of the network host serving it; undefined means this computer. */
  host?: string;
  /** Best-known context window in tokens (see resolveContextWindow). */
  contextWindow: number;
  /** Ollama only: num_ctx to send per request. undefined = don't send one,
   * respecting the server's own configured context length. */
  numCtx?: number;
  /** Model's architectural maximum, when known. */
  maxContext?: number;
  /** LM Studio only: whether the model is currently loaded. */
  loaded?: boolean;
  /** LM Studio only: reasoning levels the model supports and its default. */
  reasoning?: ReasoningInfo;
  /** Whether the model accepts image input; undefined when the backend did not say. */
  vision?: boolean;
  note?: string;
}

const DEFAULT_OLLAMA_BASE = `http://127.0.0.1:${OLLAMA_PORT}`;
const LOCAL_PROBE_TIMEOUT_MS = 3000;
// An added machine that is switched off must not hold up startup for long.
const NETWORK_PROBE_TIMEOUT_MS = 1500;
const DOCKER_DISCOVERY_TIMEOUT_MS = 2000;

const LOOPBACK_RE = /^(https?:\/\/)(localhost|127(?:\.\d+){3}|\[::1\])(?=[:/]|$)/i;

function normalizeOllamaBase(env?: string): string {
  let base: string;
  if (!env) base = DEFAULT_OLLAMA_BASE;
  else if (env.startsWith("http://") || env.startsWith("https://")) base = env.replace(/\/$/, "");
  else base = `http://${env.replace(/\/$/, "")}`;
  // OLLAMA_HOST=0.0.0.0 is the documented way to expose the SERVER on the LAN,
  // but as a CLIENT connect address 0.0.0.0/:: fails on Windows (WSAEADDRNOTAVAIL)
  // and would make detection silently return no models. Rewrite to loopback.
  base = base.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|::)(?=[:/]|$)/, "$1127.0.0.1");
  // A bare local OLLAMA_HOST is common in desktop environment settings. Ollama
  // means port 11434 there, while fetch would otherwise try port 80.
  if (/^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(base)) base += `:${OLLAMA_PORT}`;
  return base;
}

function loopbackAliases(base: string): string[] {
  const match = base.match(LOOPBACK_RE);
  if (!match) return [base];
  const tail = base.slice(match[0].length);
  return [match[2], "127.0.0.1", "localhost", "[::1]"]
    .map((host) => `${match[1]}${host}${tail}`)
    .filter((url, i, urls) => urls.indexOf(url) === i);
}

/** Probe the configured endpoint first, then every loopback spelling. A stale
 * OLLAMA_HOST does not hide a healthy local or Docker-published server. */
export function ollamaBaseUrls(env?: string): string[] {
  const primary = normalizeOllamaBase(env);
  const candidates = [...loopbackAliases(primary), ...loopbackAliases(DEFAULT_OLLAMA_BASE)];
  return candidates.filter((url, i) => candidates.indexOf(url) === i);
}

/** Loopback spellings for LM Studio: the port its settings file names (it is
 * changeable in the app), then the default. */
export function lmStudioBaseUrls(configuredPort?: number): string[] {
  const ports = [configuredPort, LMSTUDIO_PORT].filter((p, i, all): p is number => !!p && all.indexOf(p) === i);
  return ports.flatMap((port) => loopbackAliases(`http://127.0.0.1:${port}`));
}

/** Loopback spellings for oMLX and MTPLX: the ports their settings name,
 * then the default both share. */
function omlxBaseUrls(): string[] {
  const ports = [readOmlxSettings().port, readMtplxPort(), OMLX_PORT].filter((p, i, all): p is number => !!p && all.indexOf(p) === i);
  return ports.flatMap((port) => loopbackAliases(`http://127.0.0.1:${port}`));
}

/** Exported for tests: the port in LM Studio's http-server-config.json. */
export function parseLmStudioServerPort(text: string): number | undefined {
  try {
    const port = JSON.parse(text)?.port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** LM Studio keeps its live server settings in its home folder, which the
 * pointer file relocates when the user moved it. Missing or unreadable just
 * means we fall back to the default port. */
export function readLmStudioPort(home = os.homedir()): number | undefined {
  const homes: string[] = [];
  try {
    const pointed = fs.readFileSync(path.join(home, ".lmstudio-home-pointer"), "utf8").trim();
    if (pointed) homes.push(pointed);
  } catch {
    /* not relocated */
  }
  homes.push(path.join(home, ".lmstudio"), path.join(home, ".cache", "lm-studio"));
  for (const dir of homes) {
    try {
      const port = parseLmStudioServerPort(fs.readFileSync(path.join(dir, ".internal", "http-server-config.json"), "utf8"));
      if (port) return port;
    } catch {
      /* try the next location */
    }
  }
  return undefined;
}

/** Parse `docker ps --format {{.Ports}}` and return host endpoints that publish
 * a container's model-server port. Unpublished/expose-only ports are
 * intentionally ignored because the CLI cannot reach them from the host. */
export function parseDockerBaseUrls(output: string, containerPorts: number[] = [OLLAMA_PORT, LMSTUDIO_PORT]): string[] {
  const urls: string[] = [];
  const mapping = /(\[[^\]]+\]|(?:\d{1,3}\.){3}\d{1,3}|localhost):(\d+)->(\d+)\/tcp\b/gi;
  for (const match of output.matchAll(mapping)) {
    if (!containerPorts.includes(Number(match[3]))) continue;
    let host = match[1].toLowerCase();
    if (host === "0.0.0.0") host = "127.0.0.1";
    else if (host === "[::]") host = "[::1]";
    urls.push(`http://${host}:${match[2]}`);
  }
  return urls.filter((url, i) => urls.indexOf(url) === i);
}

function containerPublishedUrls(containerPorts: number[]): Promise<string[]> {
  const ask = (cli: string) =>
    new Promise<string[] | null>((resolve) => {
      execFile(
        cli,
        ["ps", "--format", "{{.Ports}}"],
        { encoding: "utf8", timeout: DOCKER_DISCOVERY_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : parseDockerBaseUrls(stdout, containerPorts))
      );
    });
  // Podman prints the same port format; only ask it when Docker is absent.
  return ask("docker").then((urls) => urls ?? ask("podman")).then((urls) => urls ?? []);
}

/** Exported for tests: listening ports in `lsof -Fn` output ("n127.0.0.1:8001"). */
export function parseLsofPorts(output: string): number[] {
  const ports = [...output.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1]));
  return ports.filter((p, i) => ports.indexOf(p) === i);
}

/** macOS: where running oMLX and MTPLX servers listen, whatever port they were
 * moved to (they share 8000 by default, so one of them often is). */
function mlxProcessUrls(): Promise<string[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(cmd, args, { encoding: "utf8", timeout: DOCKER_DISCOVERY_TIMEOUT_MS }, (err, stdout) => resolve(err ? "" : stdout))
    );
  return run("pgrep", ["-f", "mtplx\\.server|omlx-server"]).then(async (pids) => {
    const list = pids.split(/\s+/).filter(Boolean).join(",");
    if (!list) return [];
    const ports = parseLsofPorts(await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", list, "-Fn"]));
    return ports.map((port) => `http://127.0.0.1:${port}`);
  });
}

/** Exported for tests: the default gateway in /proc/net/route (little-endian hex). */
export function parseDefaultGateway(procNetRoute: string): string | undefined {
  for (const line of procNetRoute.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[1] !== "00000000" || !/^[0-9a-f]{8}$/i.test(cols[2]) || cols[2] === "00000000") continue;
    const hex = cols[2];
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".");
  }
  return undefined;
}

/** Inside WSL or a container, "this computer" includes the machine hosting
 * us: loopback does not reach a model server running there. */
function hostMachineUrls(ports: number[]): string[] {
  if (process.platform !== "linux") return [];
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const wsl = !!process.env.WSL_DISTRO_NAME || /microsoft/i.test(read("/proc/version"));
  const container = fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
  if (!wsl && !container) return [];
  const names = [parseDefaultGateway(read("/proc/net/route")), container ? "host.docker.internal" : undefined];
  return names.filter((n): n is string => !!n).flatMap((name) => ports.map((port) => `http://${name}:${port}`));
}

// ---- asking a server what it is ---------------------------------------------

const NOT_LOADED_NOTE =
  "not loaded yet — LM Studio will load it on first use, likely at a small default context. For longer sessions, load it in LM Studio with a bigger context first.";
const LMSTUDIO_JIT_GUESS = 4096; // LM Studio's usual default when a model is JIT-loaded
const DEFAULT_LMSTUDIO_BASE = `http://127.0.0.1:${LMSTUDIO_PORT}`;

/** LM Studio labels vision models "vlm" and text-only ones "llm". */
function visionOf(type: unknown): boolean | undefined {
  return type === "vlm" ? true : type === "llm" ? false : undefined;
}

function parseOllamaTags(data: any, base: string): DetectedModel[] | null {
  if (!data || !Array.isArray(data.models) || !data.models.every((m: any) => typeof m?.name === "string")) return null;
  return data.models.map((m: any) => ({
    id: m.name as string,
    backend: "ollama" as const,
    baseUrl: base,
    contextWindow: 0, // resolved lazily via /api/show when the model is chosen
  }));
}

/** Exported for tests: parse LM Studio's /api/v1/models listing. */
export function parseLmStudioV1(data: any, base = DEFAULT_LMSTUDIO_BASE): DetectedModel[] | null {
  if (!data || !Array.isArray(data.models)) return null;
  return data.models
    .filter((m: any) => m.type === "llm" || m.type === "vlm" || m.type === undefined)
    .map((m: any) => {
      const inst = Array.isArray(m.loaded_instances) ? m.loaded_instances[0] : undefined;
      const loaded = !!inst;
      const max = typeof m.max_context_length === "number" ? m.max_context_length : undefined;
      const loadedCtx =
        typeof inst?.config?.context_length === "number" ? inst.config.context_length : undefined;
      const r = m.capabilities?.reasoning;
      const reasoning: ReasoningInfo | undefined =
        r && Array.isArray(r.allowed_options)
          ? { allowed: r.allowed_options.map(String), default: r.default ? String(r.default) : undefined }
          : undefined;
      return {
        id: String(inst?.id ?? m.key),
        backend: "lmstudio" as const,
        baseUrl: base,
        contextWindow: loaded && loadedCtx ? loadedCtx : Math.min(max ?? LMSTUDIO_JIT_GUESS, LMSTUDIO_JIT_GUESS),
        maxContext: max,
        loaded,
        reasoning,
        vision: visionOf(m.type),
        note: loaded && loadedCtx ? undefined : NOT_LOADED_NOTE,
      };
    });
}

function parseLmStudioV0(data: any, base: string): DetectedModel[] | null {
  if (!data || !Array.isArray(data.data)) return null;
  return data.data
    .filter((m: any) => m.type === "llm" || m.type === "vlm" || m.type === undefined)
    .map((m: any) => {
      const loaded = m.state === "loaded";
      const max = typeof m.max_context_length === "number" ? m.max_context_length : undefined;
      const loadedCtx =
        typeof m.loaded_context_length === "number" ? m.loaded_context_length : undefined;
      let contextWindow: number;
      let note: string | undefined;
      if (loaded && loadedCtx) {
        contextWindow = loadedCtx;
      } else {
        contextWindow = Math.min(max ?? LMSTUDIO_JIT_GUESS, LMSTUDIO_JIT_GUESS);
        note = NOT_LOADED_NOTE;
      }
      return {
        id: m.id as string,
        backend: "lmstudio" as const,
        baseUrl: base,
        contextWindow,
        maxContext: max,
        loaded,
        vision: visionOf(m.type),
        note,
      };
    });
}

export interface ServerInfo {
  backend: BackendKind;
  baseUrl: string;
  models: DetectedModel[];
}

/** Ask one address which model server it is. null means none (or
 * nothing there). Both native listings are requested together so a dead
 * address costs one timeout, not one per backend. */
export async function identifyServer(base: string, timeoutMs = NETWORK_PROBE_TIMEOUT_MS, apiKey?: string): Promise<ServerInfo | null> {
  const keyed = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
  const [tags, v1, health] = await Promise.all([
    probeJson(`${base}/api/tags`, timeoutMs),
    probeJson(`${base}/api/v1/models`, timeoutMs),
    probeJson(`${base}/health`, timeoutMs),
  ]);
  if (!tags.reached && !v1.reached && !health.reached) return null;
  // oMLX: /health is the one open endpoint. A wrong or missing key still
  // identifies the server, with no models.
  if (isOmlxHealth(health.data)) {
    const listing = await tryFetchJson(`${base}/v1/models`, { headers: keyed ?? omlxHeaders(base) }, timeoutMs);
    return { backend: "omlx", baseUrl: base, models: parseOmlxModels(listing, base) ?? [] };
  }
  if (isMtplxHealth(health.data)) {
    const listing = await tryFetchJson(`${base}/v1/models`, { headers: keyed ?? mtplxHeaders(base) }, timeoutMs);
    return { backend: "mtplx", baseUrl: base, models: parseMtplxModels(listing, base) ?? [] };
  }
  // LM Studio first: its listing names models by "key", which nothing else does.
  const lmKeyed = Array.isArray(v1.data?.models) && v1.data.models.length > 0 && v1.data.models.every((m: any) => typeof m?.key === "string");
  if (lmKeyed) return { backend: "lmstudio", baseUrl: base, models: parseLmStudioV1(v1.data, base) ?? [] };
  const ollama = parseOllamaTags(tags.data, base);
  if (ollama) return { backend: "ollama", baseUrl: base, models: ollama };
  const lmV1 = parseLmStudioV1(v1.data, base);
  if (lmV1) return { backend: "lmstudio", baseUrl: base, models: lmV1 };

  const v0 = parseLmStudioV0(await tryFetchJson(`${base}/api/v0/models`, undefined, timeoutMs), base);
  if (v0) return { backend: "lmstudio", baseUrl: base, models: v0 };
  // Older LM Studio builds: fall back to the OpenAI-compat listing (no context info).
  const compat = await tryFetchJson(`${base}/v1/models`, undefined, timeoutMs);
  if (compat && Array.isArray(compat.data)) {
    const models = compat.data
      .filter((m: any) => !String(m.id).includes("embed"))
      .map((m: any) => ({
        id: m.id as string,
        backend: "lmstudio" as const,
        baseUrl: base,
        contextWindow: LMSTUDIO_JIT_GUESS,
        note: "context window unknown (older LM Studio) — assuming 4096 to be safe.",
      }));
    return { backend: "lmstudio", baseUrl: base, models };
  }
  return null;
}

// ---- putting it together ----------------------------------------------------

/** Spellings of ONE server, tried in order until one answers. Different
 * servers live in different groups and are probed side by side. */
interface ServerGroup {
  urls: string[];
  timeoutMs: number;
  host?: string;
}

/** Exported for tests. Loopback spellings of the same port are one server;
 * every other URL is its own. Order of first appearance is kept. */
export function groupServers(urls: string[], timeoutMs: number, host?: string): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const url of urls) {
    const loop = url.match(LOOPBACK_RE);
    const key = loop ? `loopback${url.slice(loop[0].length)}` : url;
    const group = groups.get(key) ?? { urls: [], timeoutMs, host };
    if (!group.urls.includes(url)) group.urls.push(url);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function probeGroup(group: ServerGroup): Promise<ServerInfo | null> {
  for (const url of group.urls) {
    const info = await identifyServer(url, group.timeoutMs);
    if (info) return { ...info, models: info.models.map((m) => ({ ...m, host: group.host })) };
  }
  return null;
}

export interface DetectOptions {
  /** Network hosts the user added; probed alongside this computer. */
  hosts?: SavedHost[];
  /** Return as soon as a matching model turns up (startup looks for the
   * remembered model and need not wait for a machine that is switched off). */
  until?: (m: DetectedModel) => boolean;
}

export interface HostStatus {
  host: SavedHost;
  servers: ServerInfo[];
}

/** What each saved host is serving right now (for the hosts manager). */
export async function probeHosts(hosts: SavedHost[]): Promise<HostStatus[]> {
  return Promise.all(
    hosts.map(async (host) => {
      const found = await Promise.all(groupServers(hostUrls(host), NETWORK_PROBE_TIMEOUT_MS, hostLabel(host)).map(probeGroup));
      return { host, servers: found.filter((s): s is ServerInfo => !!s) };
    })
  );
}

export async function detectAll(opts: DetectOptions = {}): Promise<DetectedModel[]> {
  const lmPort = readLmStudioPort();
  const ports = [OLLAMA_PORT, lmPort ?? LMSTUDIO_PORT, LMSTUDIO_PORT].filter((p, i, all) => all.indexOf(p) === i);
  const local = groupServers(
    [...ollamaBaseUrls(process.env.OLLAMA_HOST), ...lmStudioBaseUrls(lmPort), ...omlxBaseUrls(), ...hostMachineUrls(ports)],
    LOCAL_PROBE_TIMEOUT_MS
  );
  const covered = new Set(local.flatMap((g) => g.urls));

  // One slot per source, in display order: this computer, its containers,
  // then each added host. Slots finish at different times.
  const slots: Promise<DetectedModel[]>[] = [
    ...local.map((g) => probeGroup(g).then((s) => s?.models ?? [])),
    mlxProcessUrls().then(async (urls) => {
      const groups = groupServers(urls.filter((u) => !covered.has(u)), LOCAL_PROBE_TIMEOUT_MS);
      return (await Promise.all(groups.map(probeGroup))).flatMap((s) => s?.models ?? []);
    }),
    containerPublishedUrls(ports).then(async (urls) => {
      const groups = groupServers(urls.filter((u) => !covered.has(u)), LOCAL_PROBE_TIMEOUT_MS);
      return (await Promise.all(groups.map(probeGroup))).flatMap((s) => s?.models ?? []);
    }),
    ...(opts.hosts ?? []).flatMap((host) =>
      groupServers(hostUrls(host), NETWORK_PROBE_TIMEOUT_MS, hostLabel(host)).map((g) => probeGroup(g).then((s) => s?.models ?? []))
    ),
  ];

  const done: (DetectedModel[] | undefined)[] = slots.map(() => undefined);
  const merged = () => {
    const seen = new Set<string>();
    return done.flatMap((models) => models ?? []).filter((m) => {
      const key = `${m.baseUrl}|${m.id}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };
  return new Promise((resolve) => {
    let left = slots.length;
    slots.forEach((slot, i) =>
      slot
        .catch(() => [] as DetectedModel[])
        .then((models) => {
          done[i] = models;
          if (--left === 0 || (opts.until && models.some(opts.until))) resolve(merged());
        })
    );
  });
}

const DEFAULT_OLLAMA_CTX_CAP = 32768; // avoid surprise VRAM blowups on huge-window models

/**
 * Resolve the context window we will actually budget against for a chosen model.
 *
 * Ollama: by default we respect the SERVER's configured context (the Ollama
 * app's Context Length setting / OLLAMA_CONTEXT_LENGTH) and never send
 * num_ctx. To learn the effective value we preload the model and read
 * context_length from /api/ps. Only two cases send an explicit num_ctx: a
 * --ctx override, or an old Ollama whose /api/ps doesn't report context (where
 * the tiny silent default is the classic footgun).
 */
export async function resolveContextWindow(
  model: DetectedModel,
  ctxOverride?: number
): Promise<DetectedModel> {
  if (ctxOverride !== undefined && (!Number.isSafeInteger(ctxOverride) || ctxOverride < 1024)) throw new Error("Context window must be a whole number of at least 1024 tokens.");
  if (model.backend === "ollama") {
    const info = await tryFetchJson(`${model.baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.id }),
    });
    // Newer Ollama lists what the model can do; "vision" means it takes images.
    if (Array.isArray(info?.capabilities)) model = { ...model, vision: info.capabilities.includes("vision") };
    let max: number | undefined;
    const mi = info?.model_info;
    if (mi && typeof mi === "object") {
      for (const key of Object.keys(mi)) {
        if (key.endsWith(".context_length") && typeof mi[key] === "number") {
          max = mi[key];
          break;
        }
      }
    }

    if (ctxOverride) {
      const window = Math.min(ctxOverride, max ?? ctxOverride);
      return { ...model, maxContext: max, contextWindow: window, numCtx: window };
    }

    // Preload the model (documented no-op chat), then read the effective
    // context the server actually allocated.
    await tryFetchJson(
      `${model.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, messages: [] }),
      },
      180_000
    );
    const ps = await tryFetchJson(`${model.baseUrl}/api/ps`, undefined, 3000);
    // Match the CHOSEN model only — never fall back to models[0]. If our
    // preload failed (e.g. too big for VRAM) but a different model is still
    // resident, models[0] would anchor the budget to the wrong window.
    const entry = ps?.models?.find((m: any) => m.name === model.id || m.model === model.id);
    if (typeof entry?.context_length === "number" && entry.context_length > 0) {
      return {
        ...model,
        maxContext: max,
        contextWindow: entry.context_length,
        numCtx: undefined, // respect the server's configuration
      };
    }

    // Older Ollama: no visibility into the server default, which is tiny and
    // silently truncates — set num_ctx explicitly ourselves.
    const window = Math.min(max ?? DEFAULT_OLLAMA_CTX_CAP, DEFAULT_OLLAMA_CTX_CAP);
    return {
      ...model,
      maxContext: max,
      contextWindow: window,
      numCtx: window,
      note: `older Ollama — setting the context to ${window.toLocaleString()} explicitly (adjust with --ctx).`,
    };
  }
  if (model.loaded === false && ctxOverride) {
    const desired = Math.min(ctxOverride, model.maxContext ?? ctxOverride);
    const response = await fetch(`${model.baseUrl}/api/v1/models/load`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.id, context_length: desired, echo_load_config: true }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`LM Studio could not load ${model.id} with ${desired} context tokens (${response.status}). Load the model in LM Studio or reduce --ctx.`);
    const loaded: any = await response.json();
    const actual = loaded.load_config?.context_length;
    if (!Number.isSafeInteger(actual) || actual < 1024 || !loaded.instance_id) throw new Error("LM Studio did not confirm the loaded context. Load the model in LM Studio and select it again.");
    return { ...model, id: loaded.instance_id, loaded: true, contextWindow: Math.min(desired, actual), note: undefined };
  }
  // LM Studio: an already-loaded model stays resident; an override only shrinks our budget
  // (we cannot change what LM Studio allocated).
  if (ctxOverride && ctxOverride < model.contextWindow) {
    return { ...model, contextWindow: ctxOverride };
  }
  return model;
}

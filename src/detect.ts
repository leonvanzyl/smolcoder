// Zero-config backend detection. Probe the standard Ollama and LM Studio
// endpoints with short timeouts, merge whatever answers. No configuration.
//
// The two backends are asymmetric on context windows:
//   - Ollama: WE choose the window (num_ctx is a per-request option). Read the
//     model's true maximum from /api/show and set num_ctx explicitly, because
//     Ollama's defaults vary by version and silently truncate the prompt.
//   - LM Studio: the window is fixed when the model is loaded in LM Studio's
//     UI. We READ it from /api/v1/models (or the older /api/v0) and adapt.
//     The same endpoint tells us which reasoning levels the model supports
//     and which one it defaults to — that default is often the MAXIMUM.

import { ReasoningInfo } from "./providers/lmstudio";
import { tryFetchJson } from "./util";

export type BackendKind = "ollama" | "lmstudio";

export interface DetectedModel {
  id: string;
  backend: BackendKind;
  baseUrl: string;
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
  note?: string;
}

function ollamaBaseUrl(): string {
  const env = process.env.OLLAMA_HOST;
  let base: string;
  if (!env) base = "http://127.0.0.1:11434";
  else if (env.startsWith("http://") || env.startsWith("https://")) base = env.replace(/\/$/, "");
  else base = `http://${env.replace(/\/$/, "")}`;
  // OLLAMA_HOST=0.0.0.0 is the documented way to expose the SERVER on the LAN,
  // but as a CLIENT connect address 0.0.0.0/:: fails on Windows (WSAEADDRNOTAVAIL)
  // and would make detection silently return no models. Rewrite to loopback.
  return base.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|::)(?=[:/]|$)/, "$1127.0.0.1");
}

const DEFAULT_OLLAMA_CTX_CAP = 32768; // avoid surprise VRAM blowups on huge-window models
const LMSTUDIO_JIT_GUESS = 4096; // LM Studio's usual default when a model is JIT-loaded
const LMSTUDIO_BASE = "http://127.0.0.1:1234";

export async function detectOllamaModels(): Promise<DetectedModel[]> {
  const base = ollamaBaseUrl();
  const data = await tryFetchJson(`${base}/api/tags`);
  if (!data || !Array.isArray(data.models)) return [];
  return data.models.map((m: any) => ({
    id: m.name as string,
    backend: "ollama" as const,
    baseUrl: base,
    contextWindow: 0, // resolved lazily via /api/show when the model is chosen
  }));
}

const NOT_LOADED_NOTE =
  "not loaded yet — LM Studio will load it on first use, likely at a small default context. For longer sessions, load it in LM Studio with a bigger context first.";

/** Exported for tests: parse LM Studio's /api/v1/models listing. */
export function parseLmStudioV1(data: any): DetectedModel[] | null {
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
        baseUrl: LMSTUDIO_BASE,
        contextWindow: loaded && loadedCtx ? loadedCtx : Math.min(max ?? LMSTUDIO_JIT_GUESS, LMSTUDIO_JIT_GUESS),
        maxContext: max,
        loaded,
        reasoning,
        note: loaded && loadedCtx ? undefined : NOT_LOADED_NOTE,
      };
    });
}

export async function detectLmStudioModels(): Promise<DetectedModel[]> {
  const base = LMSTUDIO_BASE;
  // Newest listing first: it carries the loaded context, and the reasoning
  // levels the model supports (needed to make effort mean what it says).
  const v1 = parseLmStudioV1(await tryFetchJson(`${base}/api/v1/models`));
  if (v1) return v1;

  const data = await tryFetchJson(`${base}/api/v0/models`);
  if (data && Array.isArray(data.data)) {
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
          note,
        };
      });
  }
  // Older LM Studio builds: fall back to the OpenAI-compat listing (no context info).
  const v1compat = await tryFetchJson(`${base}/v1/models`);
  if (v1compat && Array.isArray(v1compat.data)) {
    return v1compat.data
      .filter((m: any) => !String(m.id).includes("embed"))
      .map((m: any) => ({
        id: m.id as string,
        backend: "lmstudio" as const,
        baseUrl: base,
        contextWindow: LMSTUDIO_JIT_GUESS,
        note: "context window unknown (older LM Studio) — assuming 4096 to be safe.",
      }));
  }
  return [];
}

export async function detectAll(): Promise<DetectedModel[]> {
  const [ollama, lmstudio] = await Promise.all([detectOllamaModels(), detectLmStudioModels()]);
  return [...ollama, ...lmstudio];
}

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
  if (model.backend === "ollama") {
    const info = await tryFetchJson(`${model.baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.id }),
    });
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
  // LM Studio: window was read during detection; an override can only shrink our budget
  // (we cannot change what LM Studio allocated).
  if (ctxOverride && ctxOverride < model.contextWindow) {
    return { ...model, contextWindow: ctxOverride };
  }
  return model;
}

// Lemonade — AMD's local model server for Ryzen AI, Radeon and CPUs
// (github.com/lemonade-sdk/lemonade). It speaks the OpenAI chat API under
// /api/v1, so the LM Studio adapter drives it. It also answers Ollama's
// routes (people move it to port 11434 so Ollama apps find it), but its
// /api/ps does not report a context and it ignores num_ctx: driven as Ollama
// it was budgeted at a window it never allocated. Its own listing names the
// context each model runs at, so it is identified before Ollama is.
//
// Lemonade sets a model's context when it loads it (ctx_size, a server-wide
// or per-model setting). We read it, and --ctx loads the model at that size.

import { tryFetchJson } from "./util";
import type { DetectedModel } from "./detect";

// Lemonade's own default ctx_size, for a model whose context it does not report.
const LEMONADE_DEFAULT_CTX = 4096;

// Deployment labels for models that are not chat models.
const NOT_CHAT = ["embeddings", "embedding", "reranking", "image", "tts", "transcription", "audio-generation", "classification", "classifier", "3d"];
// Recipes whose models are not chat models when they carry no labels.
const NOT_CHAT_RECIPES = ["sd-cpp", "whispercpp", "kokoro"];

function positive(n: unknown): number | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The OpenAI-style root of a Lemonade at `base`. /api/v1 is served by every
 * version; the bare /v1 only by newer ones. */
export function lemonadeApiBase(base: string): string {
  return `${base}/api`;
}

/** Parse Lemonade's /api/v1/models: its chat models, with the context each
 * one runs at (the loaded one, else the configured ctx_size). null when the
 * listing is not Lemonade's. */
export function parseLemonadeModels(data: any, base: string): DetectedModel[] | null {
  if (!Array.isArray(data?.data) || !data.data.some((m: any) => m?.owned_by === "lemonade")) return null;
  return data.data
    .filter((m: any) => {
      if (typeof m?.id !== "string") return false;
      const labels: string[] = Array.isArray(m.labels) ? m.labels.map(String) : [];
      if (labels.some((l) => NOT_CHAT.includes(l))) return false;
      return labels.includes("chat") || !NOT_CHAT_RECIPES.includes(m.recipe);
    })
    .map((m: any) => {
      const ctx = positive(m.context_length);
      const labels: string[] = Array.isArray(m.labels) ? m.labels.map(String) : [];
      return {
        id: m.id,
        backend: "lemonade" as const,
        baseUrl: base,
        contextWindow: ctx ?? LEMONADE_DEFAULT_CTX,
        maxContext: positive(m.max_context_window),
        vision: Array.isArray(m.labels) ? labels.includes("vision") : undefined,
        note: ctx ? undefined : `context window not reported — assuming Lemonade's default of ${LEMONADE_DEFAULT_CTX.toLocaleString()} (load with --ctx for more).`,
      };
    });
}

/** The context Lemonade loaded `modelId` with, from /api/v1/health; undefined
 * when it is not loaded or the server does not say. */
export function loadedLemonadeContext(health: any, modelId: string): number | undefined {
  const entry = Array.isArray(health?.all_models_loaded) ? health.all_models_loaded.find((m: any) => m?.model_name === modelId) : undefined;
  return positive(entry?.recipe_options?.ctx_size);
}

/** --ctx: load the model at that context, then use what Lemonade reports. */
export async function loadLemonadeModel(model: DetectedModel, ctx: number): Promise<DetectedModel> {
  const desired = Math.min(ctx, model.maxContext ?? ctx);
  const api = lemonadeApiBase(model.baseUrl);
  const response = await fetch(`${api}/v1/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model_name: model.id, ctx_size: desired }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lemonade could not load ${model.id} with ${desired} context tokens (${response.status}${text ? `: ${text.slice(0, 200)}` : ""}). Reduce --ctx or load the model in Lemonade.`);
  }
  const loaded = loadedLemonadeContext(await tryFetchJson(`${api}/v1/health`, undefined, 3000), model.id);
  return { ...model, contextWindow: Math.min(desired, loaded ?? desired), note: undefined };
}

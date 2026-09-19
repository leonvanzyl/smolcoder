// oMLX — an MLX inference server for Apple Silicon (github.com/jundot/omlx).
// It speaks the OpenAI chat API, so the LM Studio adapter drives it; what
// differs is finding it and the API key it requires on every call but /health.
//
// The key is read from oMLX's own settings, the same way LM Studio's port is
// read from its settings, so a local oMLX needs no setup. That key is only
// ever sent to this computer. Otherwise a key is saved for the server from the
// model picker (Network hosts → API key), or given as OMLX_API_KEY.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { savedKey } from "./config";
import type { DetectedModel } from "./detect";

export interface OmlxSettings {
  port?: number;
  apiKey?: string;
}

/** Port and API key from ~/.omlx/settings.json; empty when oMLX is not installed. */
export function readOmlxSettings(home = os.homedir()): OmlxSettings {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, ".omlx", "settings.json"), "utf8"));
    const port = s?.server?.port;
    const apiKey = s?.auth?.api_key;
    return {
      ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
      ...(typeof apiKey === "string" && apiKey ? { apiKey } : {}),
    };
  } catch {
    return {};
  }
}

const LOOPBACK = /^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?=[:/]|$)/i;

/** The key to send to an oMLX at `base`, if we know one: one saved for that
 * server from the picker, then OMLX_API_KEY, then (this computer only) oMLX's own. */
export function omlxApiKey(base: string, settings: OmlxSettings = readOmlxSettings()): string | undefined {
  return savedKey(base) || process.env.OMLX_API_KEY || (LOOPBACK.test(base) ? settings.apiKey : undefined);
}

export function omlxHeaders(base: string): Record<string, string> {
  const key = omlxApiKey(base);
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** oMLX answers /health with its engine pool, which nothing else does. */
export function isOmlxHealth(data: any): boolean {
  return !!data && typeof data.engine_pool === "object" && data.engine_pool !== null;
}

// oMLX's own fallback when a model's native context is unknown.
const OMLX_DEFAULT_CTX = 32768;

/** Parse oMLX's /v1/models. Its max_model_len is already the effective
 * window (per-model override, else native length capped by server policy). */
export function parseOmlxModels(data: any, base: string): DetectedModel[] | null {
  if (!Array.isArray(data?.data) || !data.data.some((m: any) => m?.owned_by === "omlx")) return null;
  return data.data
    .filter((m: any) => typeof m?.id === "string" && !/embed|rerank/i.test(m.id))
    .map((m: any) => ({
      id: m.id,
      backend: "omlx" as const,
      baseUrl: base,
      contextWindow: typeof m.max_model_len === "number" && m.max_model_len > 0 ? m.max_model_len : OMLX_DEFAULT_CTX,
    }));
}

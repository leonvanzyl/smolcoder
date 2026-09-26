// MTPLX — an MLX server with native MTP speculative decoding for Apple
// Silicon (github.com/youssofal/MTPLX). Like oMLX it speaks the OpenAI chat
// API, so the LM Studio adapter drives it. It shares oMLX's default port, 8000;
// the /health answer tells them apart.
//
// A key is only required when MTPLX listens beyond this computer
// (`mtplx serve --host 0.0.0.0 --api-key …`): saved for the server from the
// model picker, or given as MTPLX_API_KEY.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, savedKey } from "./config";
import { isChosenServer } from "./hosts";
import type { DetectedModel } from "./detect";

/** The port in the MTPLX app's settings; undefined when it is not installed. */
export function readMtplxPort(home = os.homedir()): number | undefined {
  try {
    const port = JSON.parse(fs.readFileSync(path.join(home, "Library", "Application Support", "MTPLX", "settings.json"), "utf8"))?.port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** A key saved for that server from the picker, else MTPLX_API_KEY — and
 * only for a server the user chose, never one a network search found. */
export function mtplxApiKey(base: string): string | undefined {
  const saved = savedKey(base);
  if (saved) return saved;
  return isChosenServer(base, loadConfig().hosts ?? []) ? process.env.MTPLX_API_KEY : undefined;
}

export function mtplxHeaders(base: string): Record<string, string> {
  const key = mtplxApiKey(base);
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** MTPLX's /health reports its MTP serving policy, which nothing else does. */
export function isMtplxHealth(data: any): boolean {
  return !!data && typeof data.mtp_enabled === "boolean" && typeof data.generation_mode === "string";
}

// MTPLX's own default for models without a known window.
const MTPLX_DEFAULT_CTX = 32768;

/** Parse MTPLX's /v1/models: the served chat model, with the context window
 * the server allocated and whether it takes images. */
export function parseMtplxModels(data: any, base: string): DetectedModel[] | null {
  if (!Array.isArray(data?.data) || !data.data.some((m: any) => m?.owned_by === "mtplx")) return null;
  return data.data
    .filter((m: any) => typeof m?.id === "string" && (m.capability ?? "chat") === "chat")
    .map((m: any) => ({
      id: m.id,
      backend: "mtplx" as const,
      baseUrl: base,
      contextWindow: typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : MTPLX_DEFAULT_CTX,
      vision: typeof m.supports_vision === "boolean" ? m.supports_vision : undefined,
    }));
}

// Files the user attaches to a message in the web UI: a screenshot pasted from
// the clipboard, a dropped image, or a text file. Images travel to the model
// as vision input when the model can see; text files are inlined into the
// user turn. The bytes live under ~/.smolcoder/uploads/<session>/, never
// inside the workspace, so an attachment can never dirty the user's repo.

import * as fs from "fs";
import { ImageRef } from "./providers/types";

export interface Attachment {
  id: string;
  /** The user's file name (sanitized), shown in the UI and to the model. */
  name: string;
  kind: "image" | "text";
  mime: string;
  size: number;
  /** Absolute path of the stored bytes. */
  path: string;
}

/** What a user turn carries when it has attachments; a turn without any is a
 * plain string, which is all the terminal UI ever produces. */
export interface UserInput {
  text: string;
  attachments: Attachment[];
}

/** Largest single upload the hub accepts. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Text files are inlined into the prompt, so they must stay small enough for
 * a local model's context window. */
export const MAX_TEXT_BYTES = 48 * 1024;
/** Rough prompt cost of one image for the context gauge: a screenshot on a
 * qwen-vl class model lands around here after the backend's own resize. */
export const IMAGE_TOKENS = 1500;

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Strip any path and control characters from a user-supplied file name. */
export function safeName(name: unknown): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
  return cleaned || "file";
}

/** Extension for the stored copy: from the name when it has one, else from the
 * declared type (a clipboard screenshot arrives as image/png with no name). */
export function extOf(name: string, mime: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  const type = mime.toLowerCase().split(";")[0].trim();
  for (const [ext, t] of Object.entries(IMAGE_MIMES)) if (t === type) return ext;
  return type.startsWith("text/") ? "txt" : "bin";
}

/** Content type to serve a stored upload with. Everything that is not a
 * raster image was accepted as text. */
export function mimeForExt(ext: string): string {
  return IMAGE_MIMES[ext.toLowerCase()] ?? "text/plain; charset=utf-8";
}

export function looksLikeText(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/** Decide how an upload is used, or say why it cannot be. */
export function classifyUpload(
  name: string,
  mime: string,
  bytes: Buffer
): { kind: "image" | "text"; mime: string } | { error: string } {
  if (bytes.length === 0) return { error: `"${name}" is empty.` };
  const ext = extOf(name, mime);
  if (IMAGE_MIMES[ext]) return { kind: "image", mime: IMAGE_MIMES[ext] };
  if (!looksLikeText(bytes)) {
    return { error: `"${name}" is not a supported attachment. Images (png, jpg, gif, webp) and text files can be attached.` };
  }
  if (bytes.length > MAX_TEXT_BYTES) {
    return {
      error: `"${name}" is too large to attach as text (${Math.round(bytes.length / 1024)} KB; the limit is ${MAX_TEXT_BYTES / 1024} KB). Put it in the workspace and ask the agent to read it.`,
    };
  }
  return { kind: "text", mime: "text/plain; charset=utf-8" };
}

/** Base64 of a stored image, or null when the file is gone: a deleted upload
 * must not fail the whole request. */
export function imageBase64(ref: ImageRef): string | null {
  try {
    return fs.readFileSync(ref.path).toString("base64");
  } catch {
    return null;
  }
}

export function imageDataUrl(ref: ImageRef): string | null {
  const b64 = imageBase64(ref);
  return b64 === null ? null : `data:${ref.mime};base64,${b64}`;
}

const FENCE = "```";

/** The prompt text and image references for a turn's attachments. Text files
 * are inlined verbatim; images become vision input when the model can see,
 * otherwise a note so the model can tell the user what it cannot do. */
export function renderAttachmentsForModel(
  attachments: Attachment[],
  canSeeImages: boolean
): { text: string; images: ImageRef[] } {
  const parts: string[] = [];
  const images: ImageRef[] = [];
  for (const a of attachments) {
    if (a.kind === "image") {
      if (canSeeImages) {
        images.push({ path: a.path, mime: a.mime, name: a.name });
        parts.push(`[Attached image: ${a.name}]`);
      } else {
        parts.push(
          `[Attached image: ${a.name} — this model cannot view images. If the image matters, tell the user to switch to a vision-capable model with /models.]`
        );
      }
      continue;
    }
    let body: string;
    try {
      body = fs.readFileSync(a.path, "utf8");
    } catch {
      body = "(the file is no longer available)";
    }
    if (body.length > MAX_TEXT_BYTES) body = body.slice(0, MAX_TEXT_BYTES) + `\n… [truncated: ${a.size} bytes in total]`;
    const fence = body.includes(FENCE) ? FENCE + "`" : FENCE;
    parts.push(`[Attached file: ${a.name} (${a.size} bytes)]\n${fence}\n${body}\n${fence}`);
  }
  return { text: parts.join("\n\n"), images };
}

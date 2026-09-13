import * as fs from "fs";
import { resolveInWorkspace } from "./sandbox";

/** A repeat hint only: timings, coordinates and stack line numbers may vary.
 * The original output remains the evidence presented to the model. */
export function failureSignature(output: string): string {
  return output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
}

/** Conventional project checks, without executing or interpolating package data.
 * Caller-owned acceptance commands take precedence in the final gate. */
export function projectVerification(workspace: string): string | undefined {
  let file: string;
  try { file = resolveInWorkspace(workspace, "package.json"); } catch { return; }
  if (!fs.existsSync(file)) return;
  try {
    if (fs.statSync(file).size > 1024 * 1024) return "npm run build --if-present";
    const scripts = JSON.parse(fs.readFileSync(file, "utf8")).scripts;
    if (!scripts || typeof scripts !== "object") return;
    const commands = ["build", "test", "test:e2e"].filter(name => typeof scripts[name] === "string" && scripts[name].trim())
      .map(name => `npm run ${name}`);
    return commands.length ? commands.join(" && ") : undefined;
  } catch {
    // npm reports malformed package metadata precisely; never silently bless it.
    return "npm run build --if-present";
  }
}

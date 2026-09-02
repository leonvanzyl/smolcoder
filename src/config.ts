// User config (~/.smolcoder.json) and the data directory (~/.smolcoder/) that
// holds saved web sessions and the workspace list. Shared by the CLI entry
// point, the session loop and the web hub.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Effort } from "./providers/types";
import { Mode } from "./tools/index";

export const CONFIG_PATH = path.join(os.homedir(), ".smolcoder.json");
export const DATA_DIR = path.join(os.homedir(), ".smolcoder");

export interface Config {
  lastModel?: string;
  lastMode?: Mode;
  effort?: Effort | null;
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
    return cfg;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {
    /* non-fatal */
  }
}

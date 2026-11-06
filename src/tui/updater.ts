// The terminal side of updating: the startup check (a line on the home
// screen, a one-time toast in a session) and /update (a panel that checks,
// shows what would run, streams the package manager's output, and offers a
// restart). The work itself is in ../update.ts; the restart in index.ts.

import * as os from "os";
import {
  autoCheckAllowed,
  checkForUpdate,
  CURRENT_VERSION,
  detectThisInstall,
  InstallInfo,
  releaseUrl,
  runUpdate,
  RunOptions,
  RunResult,
  UpdateInfo,
} from "../update";
import { theme } from "./theme";
import { PanelLine, Tui } from "./tui";

export interface TuiUpdateDeps {
  current?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests answer for the registry, the install and the package manager. */
  check?: (force: boolean) => Promise<UpdateInfo | null>;
  detect?: () => Promise<InstallInfo>;
  run?: (info: InstallInfo, o: RunOptions) => Promise<RunResult>;
  /** Background tasks that a restart stops. */
  runningTasks?: () => number;
  /** "Restart now": save and hand the terminal to the updated copy. */
  restart?: (info: InstallInfo, version: string) => void | Promise<void>;
}

function checker(d: TuiUpdateDeps): (force: boolean) => Promise<UpdateInfo | null> {
  return d.check ?? ((force) => checkForUpdate({ force, dataDir: d.dataDir, current: d.current, env: d.env }));
}

/** The startup check: never blocks, silent on failure, skipped when turned
 * off or in CI. Resolves with what it found (for tests). */
export async function watchForUpdates(tui: Tui, d: TuiUpdateDeps = {}): Promise<UpdateInfo | null> {
  if (!autoCheckAllowed(d.env ?? process.env)) return null;
  let info: UpdateInfo | null = null;
  try {
    info = await checker(d)(false);
  } catch {
    return null;
  }
  if (info?.newer) tui.setUpdateAvailable(info.latest);
  return info;
}

function tilde(p: string): string {
  const home = os.homedir();
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
}

/** /update in the terminal. */
export async function runUpdateFlow(tui: Tui, d: TuiUpdateDeps = {}): Promise<void> {
  const current = d.current ?? CURRENT_VERSION;
  tui.startSpinner("Checking for a new version");
  let info: UpdateInfo | null = null;
  try {
    info = await checker(d)(true);
  } catch {
    info = null;
  } finally {
    tui.stopSpinner();
  }
  if (!info) {
    tui.notify("Could not reach the npm registry. Check the connection, then try /update again.", "warn");
    return;
  }
  if (!info.newer) {
    tui.setUpdateAvailable(null);
    tui.notify(`smolcoder ${current} is the latest version`, "success");
    return;
  }
  // The panel says it: no "is available" toast on top of it.
  tui.setUpdateAvailable(info.latest, false);
  const latest = info.latest;
  let install: InstallInfo;
  try {
    install = await (d.detect ?? (() => detectThisInstall(d.env)))();
  } catch (err: any) {
    tui.notify(`Could not tell how smolcoder was installed: ${err?.message ?? err}`, "error");
    return;
  }

  const panel = tui.openPanel("Update smolcoder");
  const lines: PanelLine[] = [
    { label: "Version", text: `${current}  ${theme.opts.ascii ? "->" : "→"}  ${latest}` },
    { label: "What's new", text: releaseUrl(latest).replace(/^https:\/\//, ""), tone: "accent" },
    { label: "Installed", text: install.label + (install.prefix ? `  ${tilde(install.prefix)}` : ""), tone: "muted" },
  ];
  if (install.command) lines.push({ label: "Runs", text: install.command.display });
  panel.info(lines);

  if (!install.command) {
    panel.status("info", `${install.reason ?? install.manual ?? "This copy cannot update itself"}\n  ${install.manualCommand ?? "npm install -g smolcoder@latest"}`);
    await panel.choose([{ label: "Close", key: "esc" }]);
    panel.close();
    return;
  }
  const go = await panel.choose([
    { label: `Update to ${latest}`, key: "enter" },
    { label: "Not now", key: "esc" },
  ]);
  if (go !== 0) {
    panel.close();
    return;
  }

  // The output starts with the command: "Runs" would say it twice.
  panel.info(lines.filter((l) => l.label !== "Runs"));
  panel.busy(`Installing ${latest}`);
  const res = await (d.run ?? runUpdate)(install, { latest, env: d.env, onOutput: (s) => panel.log(s) });
  panel.busy(null);
  if (!res.ok) {
    panel.status(res.permission ? "warn" : "error", res.message);
    await panel.choose([{ label: "Close", key: "esc" }]);
    panel.close();
    return;
  }

  const version = res.version ?? latest;
  tui.setUpdateInstalled(version);
  const tasks = d.runningTasks?.() ?? 0;
  panel.status(
    "success",
    `Updated to ${version}\nRestart now to use it; this session reopens where you left off.${tasks ? `\nThe ${tasks} background task${tasks === 1 ? "" : "s"} it started will stop.` : ""}`
  );
  const again = d.restart
    ? await panel.choose([
        { label: "Restart now", key: "enter" },
        { label: "Later", key: "esc" },
      ])
    : 1;
  if (again === 0 && d.restart) {
    panel.busy("Restarting");
    await d.restart(install, version);
    return;
  }
  panel.close();
  tui.note(`· smolcoder ${version} is installed: it starts the next time smol does (this session is in /sessions)`);
}

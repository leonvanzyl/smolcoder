// Custom commands: Markdown templates in .smolcoder/commands/*.md (this
// workspace) and ~/.smolcoder/commands/*.md (everywhere). Running one types its
// expanded text as the user's message — nothing is added to the system prompt,
// there is no shell interpolation and no agent/subtask switching.
//
//   ---
//   description: Review a file for bugs
//   ---
//   Review $1 for bugs. Focus on: $2
//
// $ARGUMENTS is everything typed after the command; $1..$n are its words (the
// highest one takes the rest). A template with neither gets the words appended.

import * as fs from "fs";
import * as path from "path";
import { SlashCommand } from "./ui";

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  /** The file it came from. */
  file: string;
  scope: "workspace" | "global";
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(name);
}

export function workspaceCommandsDir(workspace: string): string {
  return path.join(workspace, ".smolcoder", "commands");
}

export function globalCommandsDir(dataDir: string): string {
  return path.join(dataDir, "commands");
}

/** Split optional `---` frontmatter from the body. Only `description:` is read. */
export function parseCommandFile(text: string): { description: string; template: string } {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  let description = "";
  let template = src;
  if (m) {
    template = src.slice(m[0].length);
    for (const line of m[1].split("\n")) {
      const kv = /^description\s*:\s*(.*)$/i.exec(line.trim());
      if (kv) description = kv[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  template = template.trim();
  if (!description) description = (template.split("\n").find((l) => l.trim()) ?? "").trim();
  if (description.length > 70) description = description.slice(0, 69) + "…";
  return { description, template };
}

function readDir(dir: string, scope: CustomCommand["scope"]): CustomCommand[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith(".md")) continue;
    const name = n.slice(0, -3).toLowerCase();
    if (!isValidCommandName(name)) continue;
    const file = path.join(dir, n);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const { description, template } = parseCommandFile(fs.readFileSync(file, "utf8"));
      if (!template) continue;
      out.push({ name, description, template, file, scope });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

/** Workspace commands win over global ones of the same name; names taken by
 * built-in commands (`reserved`) are skipped. */
export function loadCustomCommands(workspace: string, dataDir: string, reserved: string[] = []): CustomCommand[] {
  const taken = new Set(reserved);
  const out: CustomCommand[] = [];
  for (const cmd of [...readDir(workspaceCommandsDir(workspace), "workspace"), ...readDir(globalCommandsDir(dataDir), "global")]) {
    if (taken.has(cmd.name)) continue;
    taken.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

export function customSlashCommands(cmds: CustomCommand[]): SlashCommand[] {
  return cmds.map((cmd) => ({
    name: cmd.name,
    desc: cmd.description,
    group: "Custom",
    aliases: [cmd.scope === "workspace" ? "workspace" : "global"],
  }));
}

/** Words of the typed arguments; "double" or 'single' quotes keep spaces. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The user turn a template produces for the text typed after the command. */
export function expandTemplate(template: string, input: string): string {
  input = input.trim();
  const args = splitArgs(input);
  const positions = (template.match(/\$([1-9]\d*)/g) ?? []).map((p) => Number(p.slice(1)));
  const last = positions.length ? Math.max(...positions) : 0;
  const hasArguments = template.includes("$ARGUMENTS");
  const text = template.replace(/\$(?:ARGUMENTS|([1-9]\d*))/g, (match, index) => {
    if (match === "$ARGUMENTS") return input;
    const pos = Number(index);
    if (pos - 1 >= args.length) return "";
    return pos === last ? args.slice(pos - 1).join(" ") : args[pos - 1];
  });
  if (!positions.length && !hasArguments && input) return `${text.trim()}\n\n${input}`;
  return text.trim();
}

/** Write a command file; returns its path. */
export function writeCustomCommand(dir: string, name: string, template: string, description?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  const front = description ? `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n` : "";
  fs.writeFileSync(file, `${front}${template.trim()}\n`);
  return file;
}

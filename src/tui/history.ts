// Prompt history that survives restarts: one JSON string per line in
// ~/.smolcoder/prompt-history.jsonl, newest last, deduplicated, the last 200
// kept. Read once at start; every submit appends (and the file is compacted
// when it grows past twice the cap). Failures are silent — history is a
// convenience, never a reason to break the prompt.

import * as fs from "fs";
import * as path from "path";

export const HISTORY_LIMIT = 200;

export class PromptHistory {
  entries: string[] = [];
  private fileLines = 0;

  constructor(private file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      this.fileLines = lines.length;
      const seen = new Set<string>();
      const out: string[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < HISTORY_LIMIT; i--) {
        let text: unknown;
        try {
          text = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (typeof text === "object" && text && typeof (text as any).text === "string") text = (text as any).text;
        if (typeof text !== "string" || !text.trim() || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
      }
      this.entries = out.reverse();
    } catch {
      /* no history yet */
    }
  }

  add(text: string): void {
    if (!text.trim()) return;
    const at = this.entries.lastIndexOf(text);
    if (at >= 0) this.entries.splice(at, 1);
    this.entries.push(text);
    if (this.entries.length > HISTORY_LIMIT) this.entries.splice(0, this.entries.length - HISTORY_LIMIT);
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.fileLines + 1 > HISTORY_LIMIT * 2) {
        fs.writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
        this.fileLines = this.entries.length;
      } else {
        fs.appendFileSync(this.file, JSON.stringify(text) + "\n");
        this.fileLines++;
      }
    } catch {
      /* read-only home: keep the in-memory history */
    }
  }
}

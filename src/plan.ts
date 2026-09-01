// The agent's plan: a harness-held checklist. This is deliberately NOT a file
// and NOT model-formatted text — the harness owns the state, so rendering it
// to the user costs zero tokens, and compaction can never destroy it. For a
// small model it works as a compass: every `done` result re-states what comes
// next, and after compaction the whole checklist is re-injected verbatim.

export interface PlanStep {
  text: string;
  done: boolean;
}

export class Plan {
  steps: PlanStep[] = [];

  get exists(): boolean {
    return this.steps.length > 0;
  }

  get doneCount(): number {
    return this.steps.filter((s) => s.done).length;
  }

  /** Index of the current (first undone) step, or -1 when all done/empty. */
  get currentIndex(): number {
    return this.steps.findIndex((s) => !s.done);
  }

  reset(): void {
    this.steps = [];
  }

  /** Replace the plan. Steps arrive as one newline-separated string — the most
   * reliable shape for small models (no arrays to mangle). */
  set(stepsText: string): string {
    const lines = stepsText
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[.\]\s*)?/, "").trim())
      .filter(Boolean)
      .slice(0, 20);
    if (lines.length === 0) {
      return 'Error: steps is required — one step per line. Example: {"action": "set", "steps": "create index.html\\ncreate game.js\\ntest the page"}';
    }
    this.steps = lines.map((text) => ({ text, done: false }));
    return `Plan set (${this.steps.length} steps). Current: 1. ${this.steps[0].text}`;
  }

  /** Mark a step done. No index = the current step. Returns a compact
   * "what's next" line — cheap tokens that keep the model on course. */
  markDone(stepNumber?: number): string {
    if (!this.exists) return 'Error: no plan yet. Create one first with {"action": "set", "steps": "..."}';
    let idx: number;
    if (stepNumber === undefined || stepNumber === null) {
      idx = this.currentIndex;
      if (idx < 0) return "All steps are already done.";
    } else {
      idx = Math.floor(stepNumber) - 1;
      if (idx < 0 || idx >= this.steps.length) {
        return `Error: step ${stepNumber} does not exist. The plan has ${this.steps.length} steps.`;
      }
    }
    this.steps[idx].done = true;
    const next = this.currentIndex;
    return next < 0
      ? `Done: ${idx + 1}. All ${this.steps.length} steps complete.`
      : `Done: ${idx + 1}. Next: ${next + 1}. ${this.steps[next].text}`;
  }

  add(text: string): string {
    if (typeof text !== "string" || !text.trim()) {
      return 'Error: text is required. Example: {"action": "add", "text": "fix the collision bug"}';
    }
    if (this.steps.length >= 20) return "Error: the plan already has 20 steps — finish some first.";
    this.steps.push({ text: text.trim(), done: false });
    return `Added step ${this.steps.length}: ${text.trim()}`;
  }

  /** Compact model-facing checklist (used by action "show" and after compaction). */
  modelView(): string {
    if (!this.exists) return "No plan set.";
    return this.steps
      .map((s, i) => `${i + 1}.[${s.done ? "x" : i === this.currentIndex ? ">" : " "}] ${s.text}`)
      .join("\n");
  }

  /** One-line summary for the compaction state note. */
  compactLine(): string | null {
    if (!this.exists) return null;
    return `Plan (${this.doneCount}/${this.steps.length} done):\n${this.modelView()}`;
  }

  pendingSummary(): string {
    return this.steps
      .filter((s) => !s.done)
      .map((s) => s.text)
      .join("; ");
  }
}

// Hand-rolled terminal key decoder (zero deps). Parses VT escape sequences
// from raw-mode stdin, including bracketed paste so pasted newlines insert
// instead of submitting.

export type KeyType =
  | "char"
  | "text" // multi-char printable run (fast typing or paste)
  | "enter"
  | "tab"
  | "shifttab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "esc"
  | "ctrlc"
  | "ctrld"
  | "ctrlu"
  | "ctrlw"
  | "ctrla"
  | "ctrle";

export interface Key {
  type: KeyType;
  text?: string;
}

const CSI_MAP: Record<string, KeyType> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shifttab",
  "1~": "home",
  "3~": "delete",
  "4~": "end",
  "7~": "home",
  "8~": "end",
};

function normalizePaste(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // strip control chars except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export class KeyDecoder {
  private pasteBuf: string | null = null;

  decode(s: string): Key[] {
    const out: Key[] = [];
    let i = 0;
    while (i < s.length) {
      // inside a bracketed paste: consume until the end marker
      if (this.pasteBuf !== null) {
        const end = s.indexOf("\x1b[201~", i);
        if (end < 0) {
          this.pasteBuf += s.slice(i);
          return out;
        }
        this.pasteBuf += s.slice(i, end);
        out.push({ type: "text", text: normalizePaste(this.pasteBuf) });
        this.pasteBuf = null;
        i = end + 6;
        continue;
      }

      const ch = s[i];
      if (ch === "\x1b") {
        if (s.startsWith("\x1b[200~", i)) {
          this.pasteBuf = "";
          i += 6;
          continue;
        }
        if (s[i + 1] === "[") {
          let j = i + 2;
          while (j < s.length && !(s[j] >= "@" && s[j] <= "~")) j++;
          if (j >= s.length) break; // incomplete sequence — drop
          const seq = s.slice(i + 2, j + 1);
          const mapped = CSI_MAP[seq];
          if (mapped) out.push({ type: mapped });
          i = j + 1;
          continue;
        }
        if (s[i + 1] === "O" && i + 2 < s.length) {
          const mapped = CSI_MAP[s[i + 2]];
          if (mapped) out.push({ type: mapped });
          i += 3;
          continue;
        }
        out.push({ type: "esc" });
        i++;
        continue;
      }

      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") { out.push({ type: "enter" }); i++; continue; }
      if (ch === "\t") { out.push({ type: "tab" }); i++; continue; }
      if (code === 127 || code === 8) { out.push({ type: "backspace" }); i++; continue; }
      if (code === 3) { out.push({ type: "ctrlc" }); i++; continue; }
      if (code === 4) { out.push({ type: "ctrld" }); i++; continue; }
      if (code === 21) { out.push({ type: "ctrlu" }); i++; continue; }
      if (code === 23) { out.push({ type: "ctrlw" }); i++; continue; }
      if (code === 1) { out.push({ type: "ctrla" }); i++; continue; }
      if (code === 5) { out.push({ type: "ctrle" }); i++; continue; }
      if (code < 32) { i++; continue; } // other control chars: ignore

      // printable run (single keystroke or unbracketed paste)
      let j = i;
      let run = "";
      while (j < s.length) {
        const cj = s[j];
        const cc = cj.charCodeAt(0);
        if (cj === "\x1b" || cj === "\r" || cj === "\n" || cj === "\t" || cc < 32 || cc === 127) break;
        run += cj;
        j++;
      }
      out.push(run.length === 1 ? { type: "char", text: run } : { type: "text", text: run });
      i = j;
    }
    return out;
  }
}

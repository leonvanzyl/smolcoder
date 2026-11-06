// Hand-rolled terminal key decoder (zero deps). Parses VT escape sequences
// from raw-mode stdin, including bracketed paste so pasted newlines insert
// instead of submitting.
//
// - ESC followed by a character is alt+character, not a bare esc.
// - An escape sequence cut across two reads is carried over to the next one.
//   A lone ESC at the end of a read is held until flush() — the caller runs
//   it after a short pause, so a real Esc press still arrives as "esc".
// - Terminal replies (OSC color answers, DA, cursor reports) are swallowed:
//   they never reach the input. An OSC reply surfaces as an "osc" key so the
//   UI can read the background color it asked for.

export type KeyType =
  | "char"
  | "text" // multi-char printable run (fast typing or paste)
  | "enter"
  | "newline" // alt+enter, ctrl+j, shift+enter (where the terminal tells)
  | "tab"
  | "shifttab"
  | "backspace"
  | "wordbackspace"
  | "delete"
  | "worddelete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "wordleft"
  | "wordright"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "esc"
  | "ctrlc"
  | "ctrld"
  | "ctrlu"
  | "ctrlw"
  | "ctrla"
  | "ctrle"
  | "ctrlk"
  | "ctrlo"
  | "ctrlp"
  | "ctrlr"
  | "ctrlf"
  | "ctrll"
  | "f2"
  | "shiftup" // scroll the transcript a line
  | "shiftdown"
  | "ctrlhome" // jump to the top / bottom of the transcript
  | "ctrlend"
  | "mouse" // an SGR mouse report (see Key.mouse)
  | "alt" // alt+<text> that has no binding
  | "osc" // a terminal reply to an OSC query; text is the body
  | "da"; // a device-attributes reply (used as a "no more replies" sentinel)

export interface MouseEvent {
  /** 0 left, 1 middle, 2 right; 64 wheel up, 65 wheel down. */
  button: number;
  /** 0-based cell. */
  x: number;
  y: number;
  /** "press", "release", or "drag" (motion with a button held). */
  action: "press" | "release" | "drag" | "move";
  shift: boolean;
}

export interface Key {
  type: KeyType;
  text?: string;
  mouse?: MouseEvent;
}

/** Final byte (or "N~") of a CSI sequence → key, before modifiers. */
const CSI_FINAL: Record<string, KeyType> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shifttab",
  "1~": "home",
  "2~": "char", // insert: ignored below
  "3~": "delete",
  "4~": "end",
  "5~": "pageup",
  "6~": "pagedown",
  "7~": "home",
  "8~": "end",
  "12~": "f2",
};

/** SS3 sequences (ESC O x). */
const SS3: Record<string, KeyType> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Q: "f2",
  M: "enter",
  // rxvt ctrl+arrows
  a: "up",
  b: "down",
  c: "wordright",
  d: "wordleft",
};

const CTRL: Record<number, KeyType> = {
  1: "ctrla",
  3: "ctrlc",
  4: "ctrld",
  5: "ctrle",
  6: "ctrlf",
  10: "newline", // ctrl+j: a lone line feed (Enter sends CR in raw mode)
  11: "ctrlk",
  12: "ctrll",
  15: "ctrlo",
  16: "ctrlp",
  18: "ctrlr",
  21: "ctrlu",
  23: "ctrlw",
};

function normalizePaste(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // strip control chars except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Apply CSI modifier (1 + shift 1 + alt 2 + ctrl 4) to a base key. */
function withMod(base: KeyType, mod: number): KeyType {
  const m = mod - 1;
  const shift = (m & 1) !== 0;
  const alt = (m & 2) !== 0;
  const ctrl = (m & 4) !== 0;
  if (ctrl && base === "home") return "ctrlhome";
  if (ctrl && base === "end") return "ctrlend";
  if (shift && !ctrl && !alt) {
    if (base === "up") return "shiftup";
    if (base === "down") return "shiftdown";
  }
  if (ctrl || alt) {
    if (base === "left") return "wordleft";
    if (base === "right") return "wordright";
    if (base === "delete") return "worddelete";
  }
  return base;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export class KeyDecoder {
  private pasteBuf: string | null = null;
  /** Bytes of an escape sequence that has not fully arrived yet. */
  private pending = "";

  /** `awaitingReply` says whether a terminal query (OSC 11) is outstanding.
   * Only then may ESC ] / P / _ / ^ open a reply still to arrive; otherwise
   * an unterminated one is alt+], alt+shift+p, alt+_ or alt+^. */
  constructor(private awaitingReply: () => boolean = () => false) {}

  /** True when a lone ESC (or a partial sequence) waits for more input. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** The pause after a read ran out: a held lone ESC is a real Esc press;
   * any other partial sequence is dropped. */
  flush(): Key[] {
    const p = this.pending;
    this.pending = "";
    if (p === "\x1b") return [{ type: "esc" }];
    return [];
  }

  decode(input: string): Key[] {
    const out: Key[] = [];
    let s = this.pending + input;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      // inside a bracketed paste: consume until the end marker (which may
      // itself be split across reads)
      if (this.pasteBuf !== null) {
        this.pasteBuf += s.slice(i);
        const end = this.pasteBuf.indexOf(PASTE_END);
        if (end < 0) return out;
        const rest = this.pasteBuf.slice(end + PASTE_END.length);
        out.push({ type: "text", text: normalizePaste(this.pasteBuf.slice(0, end)) });
        this.pasteBuf = null;
        s = rest;
        i = 0;
        continue;
      }

      const ch = s[i];
      if (ch === "\x1b") {
        const r = this.escape(s, i, out);
        if (r < 0) {
          this.pending = s.slice(i);
          return out;
        }
        i = r;
        continue;
      }

      const code = ch.charCodeAt(0);
      if (ch === "\r") {
        // "\r\n" (or "\r" with more typed text after it in the same read) is
        // an unbracketed paste of several lines: insert, don't submit.
        if (s[i + 1] === "\n") {
          out.push({ type: "newline" });
          i += 2;
          continue;
        }
        const more = i + 1 < s.length && s[i + 1] !== "\x1b" && s[i + 1] !== "\r";
        out.push({ type: more ? "newline" : "enter" });
        i++;
        continue;
      }
      if (ch === "\t") { out.push({ type: "tab" }); i++; continue; }
      if (code === 127 || code === 8) { out.push({ type: "backspace" }); i++; continue; }
      if (CTRL[code]) { out.push({ type: CTRL[code] }); i++; continue; }
      if (code < 32) { i++; continue; } // other control chars: ignore

      // printable run (single keystroke or unbracketed paste)
      let j = i;
      while (j < s.length) {
        const cc = s.charCodeAt(j);
        if (cc < 32 || cc === 127) break;
        j++;
      }
      const run = s.slice(i, j);
      out.push(Array.from(run).length === 1 ? { type: "char", text: run } : { type: "text", text: run });
      i = j;
    }
    return out;
  }

  /** Decode the escape at s[i]. Returns the index after it, or -1 when the
   * sequence is incomplete (the caller keeps it for the next read). */
  private escape(s: string, i: number, out: Key[]): number {
    if (i + 1 >= s.length) return -1; // lone ESC: wait (flush() decides)
    const next = s[i + 1];

    if (s.startsWith(PASTE_START, i)) {
      this.pasteBuf = "";
      return i + PASTE_START.length;
    }

    if (next === "[") {
      let j = i + 2;
      while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
      if (j >= s.length) return -1;
      const body = s.slice(i + 2, j);
      const final = s[j];
      // Legacy X10 mouse report (ESC [ M b x y): three raw bytes follow.
      if (final === "M" && body === "") {
        if (j + 4 > s.length) return -1;
        return j + 4;
      }
      out.push(...this.csi(body, final));
      return j + 1;
    }
    if (next === "O") {
      if (i + 2 >= s.length) return -1;
      const k = SS3[s[i + 2]];
      if (k) out.push({ type: k });
      return i + 3;
    }
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC / DCS / APC / PM: up to BEL or ST (ESC \). A complete one is a
      // terminal reply whenever it arrives; a partial one waits for more
      // only while a query is outstanding, else it is an alt+key press.
      let j = i + 2;
      let partial = false;
      while (j < s.length) {
        if (s[j] === "\x07") break;
        if (s[j] === "\x1b" && s[j + 1] === "\\") break;
        if (s[j] === "\x1b" && j + 1 >= s.length) { partial = true; break; }
        j++;
      }
      if (partial || j >= s.length) {
        if (this.awaitingReply()) return -1;
        out.push({ type: "alt", text: next });
        return i + 2;
      }
      const body = s.slice(i + 2, j);
      if (next === "]") out.push({ type: "osc", text: body });
      return s[j] === "\x07" ? j + 1 : j + 2;
    }
    if (next === "\x1b") {
      // An Esc press right before a paste in the same read: deliver both.
      if (s.startsWith(PASTE_START, i + 1)) {
        out.push({ type: "esc" });
        return i + 1;
      }
      // ESC ESC [ ... : alt + a CSI key on some terminals; else a double esc
      if (s[i + 2] === "[" || s[i + 2] === "O") {
        const r = this.escape(s, i + 1, out);
        return r;
      }
      out.push({ type: "esc" });
      return i + 1;
    }
    // alt + key
    if (next === "\r" || next === "\n") { out.push({ type: "newline" }); return i + 2; }
    if (next === "\x7f" || next === "\b") { out.push({ type: "wordbackspace" }); return i + 2; }
    const cp = s.codePointAt(i + 1)!;
    const chr = String.fromCodePoint(cp);
    if (cp < 32) {
      // alt+ctrl combos: treat the control key alone
      const k = CTRL[cp];
      if (k) out.push({ type: k });
      return i + 1 + chr.length;
    }
    const lower = chr.toLowerCase();
    if (lower === "b") out.push({ type: "wordleft" });
    else if (lower === "f") out.push({ type: "wordright" });
    else if (lower === "d") out.push({ type: "worddelete" });
    else out.push({ type: "alt", text: chr });
    return i + 1 + chr.length;
  }

  private csi(body: string, final: string): Key[] {
    // Replies to our own queries — never input.
    if (body.startsWith("?") && final === "c") return [{ type: "da" }];
    if (final === "R") return []; // cursor position report
    if ((final === "I" || final === "O") && body === "") return []; // focus in/out
    // SGR mouse: CSI < b ; x ; y M (press/motion) or m (release).
    if (body.startsWith("<") && (final === "M" || final === "m")) {
      const [bs, xs, ys] = body.slice(1).split(";");
      const b = Number(bs);
      const x = Number(xs) - 1;
      const y = Number(ys) - 1;
      if (!Number.isFinite(b) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
      const motion = (b & 32) !== 0;
      const button = b & ~(4 | 8 | 16 | 32);
      const action = final === "m" ? "release" : motion ? (button === 3 ? "move" : "drag") : "press";
      return [{ type: "mouse", mouse: { button, x, y, action, shift: (b & 4) !== 0 } }];
    }
    // CSI-u / modifyOtherKeys: "13;2u" (shift+enter), "27;3;13~"
    if (final === "u") {
      const [code, mod = "1"] = body.split(";");
      const m = Number(mod) - 1;
      if (code === "13") return [{ type: m > 0 ? "newline" : "enter" }];
      if (code === "27") return [{ type: "esc" }];
      if (code === "9") return [{ type: m & 1 ? "shifttab" : "tab" }];
      if (code === "127") return [{ type: m & 6 ? "wordbackspace" : "backspace" }];
      const cp = Number(code);
      if (cp >= 32 && (m & 4) === 0) return [{ type: "char", text: String.fromCodePoint(cp) }];
      if (m & 4 && cp >= 97 && cp <= 122) {
        const k = CTRL[cp - 96];
        return k ? [{ type: k }] : [];
      }
      return [];
    }
    if (final === "~" && body.startsWith("27;")) {
      const [, mod, code] = body.split(";");
      if (code === "13") return [{ type: Number(mod) > 1 ? "newline" : "enter" }];
      return [];
    }
    let key: string;
    let mod = 1;
    if (final === "~") {
      const [n, m] = body.split(";");
      key = n + "~";
      if (m) mod = Number(m) || 1;
    } else {
      key = final;
      const parts = body.split(";");
      if (parts.length === 2) mod = Number(parts[1]) || 1;
    }
    const base = CSI_FINAL[key];
    if (!base || base === "char") return [];
    return [{ type: withMod(base, mod) }];
  }
}

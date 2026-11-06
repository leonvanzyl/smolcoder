// Fitting " · "-joined status rows into narrow terminals. Segments are
// dropped or shortened in priority order: the context-% segment survives
// longest, then the mode, then the model (shortened with … in the middle so
// its family and quant suffix both stay readable); extras like plan, tasks and
// effort go first, the last one first.

import { theme } from "./theme";
import { middleTruncate, stringWidth, stripAnsi, truncateWidth } from "./width";

// eslint-disable-next-line no-control-regex
const SEP_RE = / (?:\x1b\[[0-9;]*m)*·(?:\x1b\[[0-9;]*m)* /;

export function splitStatus(s: string): string[] {
  return s ? s.split(SEP_RE) : [];
}

interface Seg {
  text: string;
  role: "ctx" | "mode" | "model" | "extra";
  order: number;
}

/** Fit status segments to `width` cells. `segments` may be colored. */
export function fitSegments(segments: string[], width: number, roles?: Seg["role"][]): string {
  const sep = ` ${theme.dim(theme.g.dot)} `;
  const sepW = stringWidth(sep);
  const segs: Seg[] = segments.map((text, i) => ({
    text,
    order: i,
    role: roles?.[i] ?? (/\d+%/.test(stripAnsi(text)) ? "ctx" : i === 0 ? "mode" : i === 1 ? "model" : "extra"),
  }));
  const join = () => segs.map((x) => x.text).join(sep);
  const fits = () => stringWidth(join()) <= width;
  if (fits()) return join();
  const drop = (role: Seg["role"]) => {
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].role === role) {
        segs.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  const shrinkModel = (min: number) => {
    const m = segs.find((x) => x.role === "model");
    if (!m) return;
    const others = segs.filter((x) => x !== m).reduce((a, x) => a + stringWidth(x.text) + sepW, 0);
    const room = Math.max(min, width - others);
    if (stringWidth(m.text) > room) m.text = middleTruncate(stripAnsi(m.text), room, theme.g.ellipsis);
  };
  while (!fits() && drop("extra"));
  if (fits()) return join();
  shrinkModel(12);
  if (fits()) return join();
  drop("mode");
  if (fits()) return join();
  shrinkModel(6);
  if (fits()) return join();
  drop("model");
  return truncateWidth(join(), width, theme.g.ellipsis);
}

/** The status row from getStatus(), fitted to `width`. */
export function fitStatus(status: string, width: number): string {
  if (stringWidth(status) <= width) return status;
  return fitSegments(splitStatus(status), width);
}

/** The context percentage in a status string, e.g. "34%", or "". */
export function ctxPercent(status: string): string {
  const m = /(\d+)%/.exec(stripAnsi(status));
  return m ? m[1] + "%" : "";
}

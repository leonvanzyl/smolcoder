// A small regex highlighter for fenced code: keywords, strings, comments and
// numbers for the languages local models write most. Line by line, with a
// carried flag for block comments and triple-quoted strings. In-house, no deps.

import { theme } from "./theme";

interface Lang {
  keywords: Set<string>;
  line?: string[]; // line-comment starters
  block?: [string, string]; // block comment delimiters
  triple?: boolean; // python-style """ strings
  backtick?: boolean; // template / raw strings in backticks
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS = words(`break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set from as interface type enum implements private public protected readonly abstract declare namespace keyof infer satisfies true false null undefined`);
const PY = words(`and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self match case`);
const GO = words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota`);
const RUST = words(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err`);
const CLIKE = words(`auto break case catch char class const continue default delete do double else enum extern final finally float for goto if implements import int interface long namespace new null nullptr package private protected public return short signed sizeof static struct super switch template this throw throws try typedef typename union unsigned using var virtual void volatile while bool true false string override readonly async await`);
const SH = words(`if then else elif fi for while until do done case esac function in return export local readonly echo exit set unset source`);
const SQL = words(`select from where insert into values update set delete create table drop alter add primary key foreign references join left right inner outer on group by order having limit offset as and or not null is in like distinct union all index`);
const JSONW = words(`true false null`);

const LANGS: Record<string, Lang> = {
  js: { keywords: JS, line: ["//"], block: ["/*", "*/"], backtick: true },
  py: { keywords: PY, line: ["#"], triple: true },
  go: { keywords: GO, line: ["//"], block: ["/*", "*/"], backtick: true },
  rust: { keywords: RUST, line: ["//"], block: ["/*", "*/"] },
  c: { keywords: CLIKE, line: ["//"], block: ["/*", "*/"] },
  sh: { keywords: SH, line: ["#"] },
  sql: { keywords: SQL, line: ["--"], block: ["/*", "*/"] },
  json: { keywords: JSONW },
  yaml: { keywords: JSONW, line: ["#"] },
};

const ALIASES: Record<string, string> = {
  js: "js", javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js",
  py: "py", python: "py",
  go: "go", golang: "go",
  rs: "rust", rust: "rust",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", java: "c", cs: "c", csharp: "c", kotlin: "c", kt: "c", swift: "c", php: "c",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", ps1: "sh", powershell: "sh",
  sql: "sql",
  json: "json", jsonc: "js",
  yaml: "yaml", yml: "yaml", toml: "yaml",
};

export function langOf(tag: string): string | null {
  return ALIASES[tag.trim().toLowerCase()] ?? null;
}

/** Highlighter state carried from one line to the next. */
export interface HlState {
  inBlock?: boolean;
  inTriple?: string; // the quote run that closes it
}

/** Highlight one line of code. Returns the colored line; `st` is updated. */
export function highlightLine(line: string, lang: string | null, st: HlState): string {
  const L = lang ? LANGS[lang] : null;
  if (!L || !theme.opts.color) return line;
  const t = theme;
  let out = "";
  let i = 0;
  const n = line.length;
  if (st.inBlock && L.block) {
    const end = line.indexOf(L.block[1]);
    if (end < 0) return t.com(line);
    out += t.com(line.slice(0, end + L.block[1].length));
    i = end + L.block[1].length;
    st.inBlock = false;
  }
  if (st.inTriple) {
    const end = line.indexOf(st.inTriple);
    if (end < 0) return t.str(line);
    out += t.str(line.slice(0, end + 3));
    i = end + 3;
    st.inTriple = undefined;
  }
  while (i < n) {
    const rest = line.slice(i);
    if (L.line && L.line.some((p) => rest.startsWith(p))) {
      out += t.com(rest);
      break;
    }
    if (L.block && rest.startsWith(L.block[0])) {
      const end = rest.indexOf(L.block[1], L.block[0].length);
      if (end < 0) {
        out += t.com(rest);
        st.inBlock = true;
        break;
      }
      out += t.com(rest.slice(0, end + L.block[1].length));
      i += end + L.block[1].length;
      continue;
    }
    if (L.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const q = rest.slice(0, 3);
      const end = rest.indexOf(q, 3);
      if (end < 0) {
        out += t.str(rest);
        st.inTriple = q;
        break;
      }
      out += t.str(rest.slice(0, end + 3));
      i += end + 3;
      continue;
    }
    const ch = line[i];
    if (ch === '"' || ch === "'" || (ch === "`" && L.backtick)) {
      let j = i + 1;
      while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      out += t.str(line.slice(i, j));
      i = j;
      continue;
    }
    const num = /^(?:0x[0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/i.exec(rest);
    if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      out += t.num(num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const key = lang === "sql" ? w.toLowerCase() : w;
      if (L.keywords.has(key)) out += t.kw(w);
      else if (line[i + w.length] === "(") out += t.fn(w);
      else out += w;
      i += w.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

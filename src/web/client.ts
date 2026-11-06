// The browser-side script for the web page. Plain JS in a raw template string
// (no build step, no dependencies). Rules: no template literals in here, and
// a literal backtick is written as \` — String.raw hands it through as-is.
//
// Layout: a workspace sidebar on the left, the active session's transcript in
// the middle, and an optional right panel with browser and terminal tabs.
// Every session keeps its own view (transcript DOM, status, draft input,
// panel tabs) so switching is instant and background sessions keep streaming.

import { fuzzyScore } from "../util";

export const CLIENT_JS = String.raw`
"use strict";
const k = new URLSearchParams(location.search).get("k") || "";
const $ = (id) => document.getElementById(id);
const ls = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch (e) {} },
  del(key) { try { localStorage.removeItem(key); } catch (e) {} },
};
// On a Mac, Option (Alt) types characters: Option+N starts "ñ", Option+2 is
// "™". So in a text field the sidebar shortcuts take Ctrl+Option there.
const IS_MAC = /mac|iphone|ipad/i.test(String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ""));
const ALT = IS_MAC ? "Ctrl+Alt" : "Alt";
const logwrap = $("logwrap"), logsEl = $("logs"), busyEl = $("busy"), actionBtn = $("actionbtn");
const jumpBottom = $("jumpbottom");
const input = $("input"), menu = $("menu"), sideEl = $("side"), panelEl = $("panel"), tabsEl = $("paneltabs");

let hub = { workspaces: [], home: "", version: "" };
const sessInfo = new Map();   // sid -> sidebar entry from the last hub snapshot
const views = new Map();      // sid -> per-session view state
let active = null;
let pendingSelect = null;
let busyTimer = null;
let uidCounter = 0;
const uid = () => "u" + (++uidCounter) + "_" + Date.now().toString(36);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function post(path, body) {
  return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({}));
}

// ---- fuzzy matching (the same scorer the terminal uses) --------------------
const fuzzyScore = ${fuzzyScore.toString()};
// Best score over an item's fields; earlier fields weigh more. Ties keep order.
function rank(query, items, fields) {
  if (!String(query || "").trim()) return items.slice();
  const scored = [];
  items.forEach((it, i) => {
    let best = null;
    fields(it).forEach((f, fi) => {
      if (!f) return;
      const s = fuzzyScore(query, String(f));
      if (s === null) return;
      const w = s / (fi + 1);
      if (best === null || w > best) best = w;
    });
    if (best !== null) scored.push({ it, s: best, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.it);
}
// Rows with the same group kept together, groups in order of first appearance.
function grouped(items) {
  const order = [], by = new Map();
  for (const it of items) { const g = it.group || ""; if (!by.has(g)) { by.set(g, []); order.push(g); } by.get(g).push(it); }
  return [].concat(...order.map((g) => by.get(g)));
}

// ---- toasts (never a blocking alert: it freezes every session's stream) ---
function toast(msg, opts) {
  opts = opts || {};
  const box = $("toasts");
  const t = el("div", "toast" + (opts.kind ? " " + opts.kind : ""));
  t.setAttribute("role", opts.kind === "error" ? "alert" : "status");
  t.appendChild(el("span", "toast-msg", String(msg)));
  let timer = null;
  const close = () => { if (timer) clearTimeout(timer); t.remove(); };
  if (opts.action) {
    const b = el("button", "toast-action", opts.action.label); b.type = "button";
    b.onclick = () => { close(); opts.action.run(); };
    t.appendChild(b);
  }
  const x = el("button", "toast-x", "×"); x.type = "button"; x.title = "Dismiss"; x.setAttribute("aria-label", "Dismiss"); x.onclick = close;
  t.appendChild(x);
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  placeToasts();
  const ms = opts.ms || (opts.action ? 10000 : opts.kind === "error" ? 9000 : 3500);
  const arm = () => { timer = setTimeout(close, ms); };
  t.onmouseenter = () => { if (timer) clearTimeout(timer); };
  t.onmouseleave = arm;
  arm();
  return t;
}
// Toasts sit above the composer and its queue chips, and step out of the way
// of anything open over the page (the palette, a picker, a menu, the slash
// menu): they never cover it.
function placeToasts() {
  const box = $("toasts");
  if (!box || !box.children.length) return;
  const gap = 8, vh = window.innerHeight;
  let base = 16;
  const bottomEl = $("bottom");
  if (bottomEl && !bottomEl.hidden) {
    let top = bottomEl.querySelector(".inner").getBoundingClientRect().top;
    for (const id of ["queuerow", "jumpbottom"]) { const n = $(id); if (n && !n.hidden) top = Math.min(top, n.getBoundingClientRect().top); }
    base = Math.max(base, vh - top + gap);
  }
  box.style.bottom = base + "px";
  box.style.zIndex = "";
  const b = box.getBoundingClientRect();
  const overlays = [];
  for (const n of document.querySelectorAll(".chooser.palette, .chooser.popover, .sb-menu, .upd-pop, #menu, dialog[open], #modal:not([hidden]) .dlg")) {
    const r = n.getBoundingClientRect();
    if (r.width && r.height && r.left < b.right && r.right > b.left) overlays.push(r);
  }
  if (!overlays.length) return;
  const h = b.height, want = vh - base - h;
  const clear = (top) => top >= gap && top + h <= vh - gap && !overlays.some((r) => top < r.bottom + gap && top + h > r.top - gap);
  const spots = [want];
  for (const r of overlays) spots.push(r.bottom + gap, r.top - gap - h);
  spots.sort((x, y) => Math.abs(x - want) - Math.abs(y - want));
  const top = spots.find(clear);
  if (top !== undefined) { box.style.bottom = (vh - top - h) + "px"; return; }
  // No clear spot (a short window): stay put, but beneath the open layer
  // (dialogs, pickers, the palette and menus all sit higher).
  box.style.zIndex = "49";
}
window.addEventListener("resize", placeToasts);
new MutationObserver(placeToasts).observe(document.body, { childList: true });
new ResizeObserver(placeToasts).observe($("bottom"));
function toastError(msg) { if (msg) toast(msg, { kind: "error" }); }
// A non-blocking "are you sure": the action runs only when its button is pressed.
function confirmToast(msg, label, run) { toast(msg, { kind: "warn", action: { label, run } }); }
function copyText(text, what) {
  const done = () => toast((what || "Text") + " copied", { kind: "success" });
  const fallback = () => {
    const ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    if (ok) done(); else toastError("Could not copy to the clipboard");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
function fmtDur(ms) {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}
function rel(ts) {
  const d = Date.now() - (ts || 0);
  if (!ts || d < 60e3) return "now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
  // Compact from here on too: a full date would crowd the title out of a row.
  if (d < 60 * 86400e3) return Math.floor(d / (7 * 86400e3)) + "w";
  if (d < 365 * 86400e3) return Math.floor(d / (30 * 86400e3)) + "mo";
  return Math.floor(d / (365 * 86400e3)) + "y";
}
function shortPath(p) {
  if (!p) return "";
  const home = hub.home || "";
  if (home && p.slice(0, home.length).toLowerCase() === home.toLowerCase()) p = "~" + p.slice(home.length);
  return p.replace(/\\/g, "/");
}

// ---- markdown ------------------------------------------------------------
// Model output is untrusted: escape everything first, then build tags
// ourselves. Nothing from the model is ever inserted as raw HTML.
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const SENT = String.fromCharCode(1); // never appears in escaped text
function inlineMd(s) {
  const codes = [];
  s = s.replace(/\`([^\`]+)\`/g, (m, c) => { codes.push(c); return SENT + (codes.length - 1) + SENT; });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (m, i) => "<code>" + codes[i] + "</code>");
  return s;
}
// Which way a block reads: Hebrew/Arabic letters against English words, with
// code-shaped words counting less and inline code not at all. A tie is LTR,
// so English never flips. Majority, not first letter: "Git היא מערכת…" is RTL.
// Weights ported from motcke/cursor-ext-rtl (Apache-2.0), src/textDirection.ts.
const RTL_G = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
function dirOf(text) {
  const t = String(text || "").replace(/\`[^\`]*\`/g, " ").replace(/&\w+;/g, " ");
  const rtl = (t.match(RTL_G) || []).length;
  const words = t.match(/[A-Za-z][A-Za-z0-9._\/:-]*/g) || [];
  if (!rtl) return words.length ? "ltr" : "";
  let ltr = 0;
  // Sentence punctuation is not part of a word: "peace." is prose, not a path.
  for (const w of words.map((x) => x.replace(/[._\/:-]+$/, ""))) ltr += /[._\/:]/.test(w) ? 0.25 : /^[A-Z0-9-]{2,}$/.test(w) || /^[a-z]+[A-Z]/.test(w) ? 0.5 : 1;
  return rtl > ltr ? "rtl" : "ltr";
}
// A dir attribute only where a block differs from its container.
function dirAttr(text, parent) { const d = dirOf(text); return d && d !== parent ? ' dir="' + d + '"' : ""; }
function renderMarkdown(src) {
  const lines = esc(src).split("\n");
  let out = "", i = 0;
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*\`\`\`\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !/^\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      // A language label and a copy button over every code block.
      out += '<div class="codeblock"><div class="codehead"><span class="lang">' + (fence[1] || "text") +
        '</span><button type="button" class="copybtn" title="Copy code" aria-live="polite">Copy</button></div><pre><code>' + body.join("\n") + "</code></pre></div>";
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const all = head.concat(...rows).join(" "), d = dirOf(all) || "ltr";
      const cell = (tag, c) => "<" + tag + dirAttr(c, d) + ">" + inlineMd(c) + "</" + tag + ">";
      out += "<table" + dirAttr(all, "ltr") + "><thead><tr>" + head.map((h) => cell("th", h)).join("") + "</tr></thead><tbody>";
      for (const r of rows) out += "<tr>" + r.map((c) => cell("td", c)).join("") + "</tr>";
      out += "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out += "<h" + h[1].length + dirAttr(h[2], "ltr") + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out += "<hr>"; i++; continue; }
    // NB: lines are already escaped, so the blockquote marker is "&gt;".
    if (/^\s*&gt;\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      const text = body.join(" ");
      out += "<blockquote" + dirAttr(text, "ltr") + ">" + inlineMd(text) + "</blockquote>";
      continue;
    }
    const item = /^\s*[-*+]\s+(.*)$/.test(line) ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/.test(line) ? /^\s*\d+[.)]\s+(.*)$/ : null;
    if (item) {
      // The whole list first: its direction decides which side the markers sit on.
      const want = item.source.includes("d+") ? "ol" : "ul", items = [];
      let m;
      while (i < lines.length && (m = item.exec(lines[i]))) { items.push(m[1]); i++; }
      const d = dirOf(items.join(" ")) || "ltr";
      out += "<" + want + dirAttr(items.join(" "), "ltr") + ">" + items.map((t) => "<li" + dirAttr(t, d) + ">" + inlineMd(t) + "</li>").join("") + "</" + want + ">";
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
           !/^(\s*#{1,6}\s|\s*\`\`\`|\s*>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    const text = para.join(" ");
    out += "<p" + dirAttr(text, "ltr") + ">" + inlineMd(text) + "</p>";
  }
  return out;
}

// ---- streaming markdown ---------------------------------------------------
// Finished blocks are rendered once and never touched again (so a selection
// in them survives streaming); only the tail after the last blank line
// outside a code fence is re-rendered, with unclosed markers healed.
const FENCE_RE = /^\s*\`\`\`/;
function finishedUpTo(raw, from) {
  let inFence = false, cut = from, pos = from;
  for (;;) {
    const nl = raw.indexOf("\n", pos);
    if (nl < 0) break; // the last line is still arriving
    const line = raw.slice(pos, nl);
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence && !line.trim()) cut = nl + 1;
    pos = nl + 1;
  }
  return cut;
}
// Close what the model has opened but not closed yet, for display only.
function healTail(s) {
  const fences = (s.match(/^\s*\`\`\`/gm) || []).length;
  if (fences % 2) return s + (s.endsWith("\n") ? "" : "\n") + "\`\`\`";
  const prose = s.replace(/^\s*\`\`\`[\s\S]*?^\s*\`\`\`.*$/gm, "");
  let out = s;
  if ((prose.match(/\`/g) || []).length % 2) out += "\`";
  const plain = prose.replace(/\`[^\`]*\`?/g, "");
  if ((plain.match(/\*\*/g) || []).length % 2) out += "**";
  return out;
}
function mdTarget(v) {
  const d = el("div", "md");
  const copy = el("button", "msgcopy", "Copy"); copy.type = "button"; copy.title = "Copy this message (markdown)";
  d.appendChild(copy);
  d._tail = el("div", "mdtail"); d.appendChild(d._tail);
  d._raw = ""; d._frozen = 0; d._tailHtml = "";
  return add(v, d);
}
function renderMd(v, target, final) {
  const raw = target._raw || "";
  const cut = final ? raw.length : finishedUpTo(raw, target._frozen);
  if (cut > target._frozen) {
    const html = renderMarkdown(raw.slice(target._frozen, cut));
    if (html) target._tail.insertAdjacentHTML("beforebegin", html);
    target._frozen = cut;
  }
  const rest = raw.slice(target._frozen);
  const html = rest ? renderMarkdown(final ? rest : healTail(rest)) : "";
  if (html !== target._tailHtml) { target._tail.innerHTML = html; target._tailHtml = html; }
  if (v === active) stick();
}
// NOT requestAnimationFrame: rAF never fires in background tabs, so a
// response streamed while the tab is hidden would never render.
function scheduleMd(v, target) {
  if (target._pending) return;
  target._pending = true;
  setTimeout(() => { target._pending = false; renderMd(v, target, !!target._done); }, 60);
}
// The response is over: render what is left without healing.
function endText(v) {
  const t = v.curText;
  if (!t) return;
  v.curText = null;
  t._done = true;
  if (!t._pending) renderMd(v, t, true);
}

// ---- ANSI (terminal output) -----------------------------------------------
function ansiToFrag(text) {
  const frag = document.createDocumentFragment();
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0, m, cls = [];
  const push = (s) => {
    if (!s) return;
    if (cls.length) frag.appendChild(el("span", cls.join(" "), s)); else frag.appendChild(document.createTextNode(s));
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cls = [];
      else if (c === 1) cls.push("ab");
      else if (c === 2) cls.push("ad");
      else if (c === 22) cls = cls.filter((x) => x !== "ab" && x !== "ad");
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { cls = cls.filter((x) => !/^a[39]\d$/.test(x)); cls.push("a" + c); }
      else if (c === 39) cls = cls.filter((x) => !/^a[39]\d$/.test(x));
      else if (c === 38 || c === 48) break; // 256/truecolor: not rendered
    }
  }
  push(text.slice(last));
  return frag;
}

// ---- per-session views ----------------------------------------------------
function draftKey(sid) { return "smol.draft." + sid; }
function getView(sid) {
  let v = views.get(sid);
  if (!v) {
    v = {
      sid, logEl: el("div", "log fresh"), state: { commands: [] }, curText: null, curThought: null, thoughtBuf: "", thoughtStart: 0,
      busyLabel: null, busyStart: 0, unread: false, draft: ls.get(draftKey(sid)) || "", scrollTop: null, followBottom: true, selPaused: false,
      asks: new Map(), curTool: null, planEl: null, argsRow: null, localQueue: [], histIdx: -1, files: null, args: null,
      terms: new Map(), tabs: [], activeTab: null, panelOpen: false, panelEl: el("div", "panelview"),
    };
    v.logEl.hidden = true; logsEl.appendChild(v.logEl);
    v.panelEl.hidden = true; $("panelviews").appendChild(v.panelEl);
    loadPanelState(v);
    views.set(sid, v);
  }
  return v;
}
function dropView(sid) {
  const v = views.get(sid);
  if (!v) return;
  closePicker(v);
  v.logEl.remove(); v.panelEl.remove();
  views.delete(sid);
  if (active === v) show(null);
}
// Only follow while at the bottom. Keep this per session, so returning to a
// transcript doesn't lose the place the user was reading.
function atBottom() { return logwrap.scrollHeight - logwrap.scrollTop - logwrap.clientHeight <= 2; }
// While reading (not following) the browser's scroll anchoring keeps the text
// still as rows above change size; while following it would fight the pin.
function renderJumpBottom() {
  jumpBottom.hidden = !active || atBottom();
  logwrap.classList.toggle("reading", !!active && !active.followBottom);
}
function stick() {
  if (active) {
    // A token can arrive before the browser delivers a pending scroll event.
    if (active.scrollTop !== null && logwrap.scrollTop < active.scrollTop && !atBottom()) active.followBottom = false;
    if (active.followBottom) logwrap.scrollTop = logwrap.scrollHeight;
    active.scrollTop = logwrap.scrollTop;
  }
  renderJumpBottom();
}
function scrollToBottom() {
  if (!active) return;
  active.followBottom = true; active.selPaused = false;
  logwrap.scrollTop = logwrap.scrollHeight;
  active.scrollTop = logwrap.scrollTop;
  renderJumpBottom();
}
logwrap.addEventListener("scroll", () => {
  if (active) {
    const bottom = atBottom();
    // A selection pauses following even when it sits at the bottom.
    if (!(active.selPaused && bottom)) { active.selPaused = false; active.followBottom = bottom; }
    active.scrollTop = logwrap.scrollTop;
  }
  renderJumpBottom();
}, { passive: true });
// Does a scroller inside the transcript (a tool result, a wide code block)
// take this wheel step itself? Then the transcript does not move: keep following.
function nestedScrolls(e) {
  for (let n = e.target; n && n !== logwrap && n.nodeType === 1; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const oy = getComputedStyle(n).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}
logwrap.addEventListener("wheel", (e) => {
  if (active && e.deltaY < 0 && logwrap.scrollTop > 0 && !nestedScrolls(e)) { active.followBottom = false; renderJumpBottom(); }
}, { passive: true });
// Selecting text while a reply streams pauses following, so the selection
// does not scroll away; clearing it picks following up again.
document.addEventListener("selectionchange", () => {
  const v = active;
  if (!v) return;
  const s = document.getSelection();
  const inLog = s && !s.isCollapsed && s.rangeCount && v.logEl.contains(s.getRangeAt(0).commonAncestorContainer);
  if (inLog) { if (v.followBottom) { v.followBottom = false; v.selPaused = true; renderJumpBottom(); } }
  else if (v.selPaused) { v.selPaused = false; v.followBottom = true; stick(); }
});
jumpBottom.onclick = scrollToBottom;
// Images, disclosure panels, and viewport/composer resizing can change the
// transcript height without a new message event.
const logResize = new ResizeObserver(stick);
logResize.observe(logwrap); logResize.observe(logsEl); logResize.observe($("busywrap"));
// A session opens on the SMOL logo and "What should we work on?" (the .fresh
// state, drawn in CSS) until its first user or assistant message; notes
// such as a model warning show below the logo without ending it.
const ENDS_FRESH = /(^|\s)(user|md|thought|tool)(\s|$)/;
function add(v, e) {
  v.logEl.appendChild(e);
  if (ENDS_FRESH.test(e.className || "")) v.logEl.classList.remove("fresh");
  if (v === active) stick();
  return e;
}
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
// A sent message: its text, then thumbnails for images and links for files.
function userBubble(m) {
  const d = el("div", "user", m.s || "");
  d.dir = dirOf(m.s) || "auto";
  if (m.files && m.files.length) {
    const row = el("div", "files");
    for (const f of m.files) {
      const href = f.url + "&k=" + k;
      if (f.kind === "image") {
        const a = el("a"); a.href = href; a.target = "_blank"; a.rel = "noopener";
        const img = el("img", "thumb"); img.src = href; img.alt = f.name; img.title = f.name; img.loading = "lazy";
        a.appendChild(img); row.appendChild(a);
      } else {
        const a = el("a", "filechip", f.name + " · " + fmtSize(f.size)); a.href = href; a.target = "_blank"; a.rel = "noopener";
        row.appendChild(a);
      }
    }
    d.appendChild(row);
  }
  return d;
}
// Copy buttons on code blocks and on whole assistant messages.
logsEl.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button");
  if (!b) return;
  if (b.classList.contains("copybtn")) {
    const code = b.closest(".codeblock").querySelector("pre");
    copyText(code ? code.textContent : "", "Code");
    // "Copied" for 1.5s, announced by the button's aria-live.
    b.textContent = "Copied"; b.classList.add("done");
    clearTimeout(b._reset); b._reset = setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1500);
  } else if (b.classList.contains("msgcopy")) {
    const md = b.closest(".md");
    copyText(md && md._raw ? md._raw.trim() : "", "Message");
  }
});
function endThought(v) {
  if (v.curThought) {
    // A redrawn transcript has no timing, and a near-instant thought has no
    // useful one: no "0.0s" either way.
    const secs = (Date.now() - v.thoughtStart) / 1000;
    v.curThought._preview.textContent = v.thoughtReplayed ? "thought" : secs < 0.1 ? "thought briefly" : "thought for " + secs.toFixed(1) + "s";
    v.curThought.classList.remove("live");
    v.curThought = null; v.thoughtBuf = "";
  }
}
// Something other than streamed text arrived: the reply so far is done.
function breakText(v) { endThought(v); endText(v); }
function startThought(v) {
  const thought = el("details", "thought live"), summary = el("summary");
  thought._preview = el("span", "thought-preview");
  summary.appendChild(thought._preview);
  summary.appendChild(el("span", "thought-expand", "Expand"));
  summary.appendChild(el("span", "thought-collapse", "Collapse"));
  const body = el("div", "thought-body");
  thought._body = document.createTextNode(""); body.appendChild(thought._body);
  thought.appendChild(summary); thought.appendChild(body);
  summary.addEventListener("click", () => {
    // Opening a long thought should keep its beginning in view, including
    // when it is still streaming. Native summary activation handles keys too.
    if (v === active && !thought.open) v.followBottom = false;
  });
  thought.addEventListener("toggle", () => {
    // Collapsing can put us back at the bottom without changing scrollTop,
    // so there may be no scroll event to resume following.
    if (v === active) { v.followBottom = atBottom(); stick(); }
  });
  v.thoughtStart = Date.now(); v.thoughtBuf = ""; endText(v);
  return add(v, thought);
}

const ICON_SEND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';
function setBusy(v, label) {
  v.busyLabel = label || null;
  if (label) v.busyStart = Date.now();
  if (v === active) renderBusy();
}
function renderBusy() {
  const label = active ? active.busyLabel : null;
  actionBtn.innerHTML = label ? ICON_STOP : ICON_SEND;
  actionBtn.className = label ? "stop" : "";
  actionBtn.setAttribute("aria-label", label ? "Stop" : "Send");
  actionBtn.title = label ? "interrupt the agent (esc)" : "send (enter)";
  const tick = () => {
    const s = active && active.busyLabel ? Math.floor((Date.now() - active.busyStart) / 1000) : 0;
    $("busysecs").textContent = s > 2 ? s + "s" : "";
  };
  if (label) {
    busyEl.classList.add("on");
    $("busylabel").textContent = label + "…";
    if (!busyTimer) busyTimer = setInterval(tick, 500);
    tick();
  } else {
    busyEl.classList.remove("on");
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    $("busysecs").textContent = "";
  }
  stick();
}

// The status-bar pickers send their command with "via", so the select it
// opens comes back marked and is drawn as a popover on that button.
function pick(v, name) { post("/msg", { sid: v.sid, text: "/" + name, via: name }); }
function renderState(v) {
  for (const t of v.tabs) if (t.kind === "browser") fillUrls(t, v.state.urls || []);
  if (v !== active) return;
  renderQueue();
  const s = v.state;
  const st = $("status");
  st.innerHTML = "";
  if (!s.mode) { st.textContent = "starting…"; renderCrumb(); return; }
  const command = (name) => post("/msg", { sid: v.sid, text: "/" + name });
  const mode = el("button", "statusbtn mode " + s.mode, s.mode === "ro" ? "Read-only" : s.mode === "bypass" ? "Bypass" : "Edit");
  mode.title = "Permission mode"; mode.dataset.via = "mode"; mode.onclick = () => pick(v, "mode");
  st.appendChild(mode);
  const model = el("button", "statusbtn modelpick", s.model + (s.host ? " @ " + s.host : "") + " ▾"); model.title = s.backend + (s.host ? " on " + s.host : "") + " · Switch model or find models on another machine"; model.dataset.via = "models"; model.onclick = () => pick(v, "models"); st.appendChild(model);
  const effort = el("button", "statusbtn eff", s.effort || "Auto"); effort.title = "Reasoning effort"; effort.dataset.via = "effort"; effort.onclick = () => pick(v, "effort"); st.appendChild(effort);
  st.appendChild(el("span", "grow"));
  const ctx = el("button", "statusbtn context-chip" + (s.ctxPct >= 95 ? " critical" : s.ctxPct >= 75 ? " pressure" : ""));
  const meter = document.createElement("meter"); meter.min = 0; meter.max = 100; meter.value = s.ctxPct || 0; meter.setAttribute("aria-label", "Context used");
  ctx.appendChild(meter); ctx.appendChild(document.createTextNode((s.ctxPct || 0) + "%"));
  const b = s.context; ctx.title = b ? b.prompt.toLocaleString() + " / " + b.window.toLocaleString() + " tokens · " + b.reserve.toLocaleString() + " reserved for reply · " + b.source : "Context usage";
  ctx.onclick = () => command("context"); st.appendChild(ctx);
  if (s.plan) {
    const done = s.plan.steps.filter((x) => x.done).length;
    st.appendChild(el("span", "plan-chip" + (s.plan.current < 0 ? " done" : ""), "plan " + done + "/" + s.plan.steps.length));
  }
  if (s.tasks) st.appendChild(el("span", "task-chip", s.tasks + " running"));
  if (s.outcome === "error" || s.outcome === "cancelled") {
    const paused = el("span", s.outcome === "error" ? "line-warn" : "task-chip", s.outcome === "error" ? "Paused" : "Stopped");
    paused.title = s.lastError || "Turn cancelled; progress is kept"; st.appendChild(paused);
  }
  $("ws").textContent = shortPath(s.workspace || "");
  renderCrumb();
}
// Messages waiting for the agent: chips above the composer, each removable.
function renderQueue() {
  const row = $("queuerow");
  row.innerHTML = "";
  const v = active;
  const list = v ? (v.state.queued || []).concat(v.localQueue) : [];
  row.hidden = !list.length;
  placeToasts();
  if (!list.length) return;
  // After Stop the queue waits: sending again (or Resume) goes on with it.
  const paused = !!v.state.queuePaused && (v.state.queued || []).length > 0;
  row.classList.toggle("paused", paused);
  if (paused) {
    const head = el("div", "queue-head");
    head.appendChild(el("span", "queue-label", "Paused · Send to continue"));
    head.appendChild(el("span", "grow"));
    const resume = el("button", "linkbtn queue-resume", "Resume"); resume.type = "button"; resume.title = "Send the next queued message now";
    resume.onclick = () => post("/queue/resume", { sid: v.sid }).then((r) => toastError(r && r.error));
    const clear = el("button", "linkbtn queue-clear", "Clear"); clear.type = "button"; clear.title = "Remove every queued message";
    clear.onclick = () => post("/queue/clear", { sid: v.sid }).then((r) => toastError(r && r.error));
    head.appendChild(resume); head.appendChild(clear);
    row.appendChild(head);
  } else row.appendChild(el("span", "queue-label", "Queued"));
  for (const q of list) {
    const chip = el("span", "qchip" + (q.local ? " sending" : ""));
    const text = (q.text || (q.files || []).join(", ")).replace(/\s+/g, " ");
    chip.appendChild(el("span", "qtext", text.length > 80 ? text.slice(0, 80) + "…" : text));
    chip.title = q.text || "";
    if (q.files && q.files.length) chip.appendChild(el("span", "dim", "+" + q.files.length + " file" + (q.files.length > 1 ? "s" : "")));
    if (!q.local) {
      const x = el("button", "attach-x", "×"); x.type = "button"; x.title = "remove from the queue"; x.setAttribute("aria-label", "Remove queued message");
      x.onclick = () => post("/queue/remove", { sid: v.sid, id: q.id }).then((r) => toastError(r && r.error));
      chip.appendChild(x);
    }
    row.appendChild(chip);
  }
}

function renderPlan(v, p) {
  const box = el("div", "plan");
  const done = p.steps.filter((x) => x.done).length;
  const hdr = el("div", "hdr", "Plan ");
  hdr.appendChild(el("small", "", done + "/" + p.steps.length));
  box.appendChild(hdr);
  p.steps.forEach((s, i) => {
    const cls = s.done ? "done" : i === p.current ? "cur" : "todo";
    const step = el("div", cls); step.dir = dirOf(s.text) || "auto";
    step.appendChild(el("span", "mk", s.done ? "✓" : i === p.current ? "▶" : "○"));
    step.appendChild(document.createTextNode(s.text));
    box.appendChild(step);
  });
  if (v.planEl && v.planEl.isConnected) v.planEl.replaceWith(box); else add(v, box);
  v.planEl = box;
}

// ---- tool rows ------------------------------------------------------------
// Read-only lookups that follow one another fold into one "Explored" row.
const EXPLORE = { read_file: ["read", "reads"], search: ["search", "searches"], list_files: ["listing", "listings"] };
function exploreGroup(v) {
  const d = el("details", "tool explore");
  const summary = el("summary");
  const name = el("span", "name", "Explored"), meta = el("span", "tool-args");
  summary.appendChild(name); summary.appendChild(meta);
  const body = el("div", "group-body");
  d.appendChild(summary); d.appendChild(body);
  d._group = {
    el: d,
    add(node) { body.appendChild(node); this.update(); },
    update() {
      const counts = {};
      let running = false, failed = false;
      for (const t of body.querySelectorAll(":scope > .tool")) {
        counts[t._name] = (counts[t._name] || 0) + 1;
        if (t.classList.contains("running")) running = true;
        if (t.classList.contains("failed")) failed = true;
      }
      meta.textContent = Object.keys(EXPLORE).filter((n) => counts[n]).map((n) => counts[n] + " " + EXPLORE[n][counts[n] > 1 ? 1 : 0]).join(", ");
      d.classList.toggle("running", running);
      d.classList.toggle("finished", !running && !failed);
      d.classList.toggle("failed", failed);
    },
  };
  return d._group;
}
function addTool(v, d, name) {
  if (EXPLORE[name]) {
    // Thoughts between two lookups go into the group with them, in order.
    let base = v.logEl.lastElementChild;
    const between = [];
    while (base && base.classList.contains("thought")) { between.unshift(base); base = base.previousElementSibling; }
    if (base && (base._group || base._exploreTool)) {
      let g = base._group;
      if (!g) { g = exploreGroup(v); base.replaceWith(g.el); g.add(base); }
      for (const t of between) g.add(t);
      g.add(d);
      if (v === active) stick();
      return;
    }
    d._exploreTool = true;
  }
  add(v, d);
}
function toolLabel(name) { return String(name || "").replace(/_/g, " "); }
// Tool bodies are filled in on first expand: long sessions stay light.
function fillTool(d) {
  if (d._filled || d._bodyText === undefined) return;
  d._filled = true;
  if (d._diff) d.appendChild(diffEl(d._diff));
  d.appendChild(el("pre", "result" + (d._err ? " err" : ""), d._bodyText));
}
function diffEl(diff) {
  const box = el("div", "diff");
  for (const l of diff.lines || []) {
    const op = l[0];
    const row = el("div", "dl " + (op === "+" ? "add" : op === "-" ? "del" : op === "~" ? "skip" : "ctx"));
    row.appendChild(el("span", "dm", op === "~" ? "⋯" : op === " " ? "" : op === "-" ? "−" : "+"));
    row.appendChild(el("span", "dt", l[1]));
    box.appendChild(row);
  }
  if (diff.truncated) box.appendChild(el("div", "dl skip", "… more changes not shown"));
  return box;
}
function diffStat(diff) {
  const s = el("span", "diffstat");
  s.appendChild(el("span", "add", "+" + diff.added));
  s.appendChild(el("span", "del", "−" + diff.removed));
  return s;
}
function settleTools(v) {
  for (const t of v.logEl.querySelectorAll(".tool.running")) { t.classList.remove("running"); if (t._group) t._group.update(); }
  if (v.argsRow) { v.argsRow.remove(); v.argsRow = null; }
}

// ---- event handling -------------------------------------------------------
// Set while an event the hub re-sent from a transcript is handled (a resumed
// session, a redraw after /undo): old turns never notify.
let replayEvent = false;
function handle(m) {
  replayEvent = !!m.replay;
  if (m.t === "hub") { onHub(m); return; }
  if (m.t === "reset") { resetViews(); return; }
  if (m.t === "update_open") { openUpdPop(false); return; }
  if (m.t === "synced") { replaying = false; if (active) renderState(active); return; }
  if (m.t === "closed") { dropView(m.sid); return; }
  // /undo shortened this session's transcript: it is redrawn from the replay that follows.
  if (m.t === "session_reset") { const v = views.get(m.sid); if (v) { resetView(v); if (v === active) stick(); } return; }
  if (!m.sid) return;
  const v = getView(m.sid);
  switch (m.t) {
    case "state":
      v.state = Object.assign(v.state, m.s);
      if (m.s && "queued" in m.s) v.localQueue = [];
      if (m.s && "busy" in m.s) setBusy(v, m.s.busy);
      renderState(v); break;
    case "user": breakText(v); settleTools(v); v.curTool = null; v.planEl = null; add(v, userBubble(m)); break;
    case "response_reset":
      if (v.curText) v.curText.remove();
      if (v.curThought) v.curThought.remove();
      v.curText = null; v.curThought = null; v.thoughtBuf = ""; break;
    case "token":
      endThought(v);
      if (!v.curText) v.curText = mdTarget(v);
      v.curText._raw += m.s; scheduleMd(v, v.curText); break;
    case "thinking":
      if (!v.curThought) { v.curThought = startThought(v); v.thoughtReplayed = replaying || replayEvent; }
      v.curThought._body.appendData(m.s);
      // Only the one-line preview is truncated; the full text stays available.
      v.thoughtBuf = (v.thoughtBuf + m.s).slice(-2000);
      var tt = v.thoughtBuf.replace(/\s+/g, " ").trim();
      v.curThought._preview.textContent = "Thinking… " + (tt.length > 160 ? "…" + tt.slice(-160) : tt);
      if (v === active) stick(); break;
    case "toolargs": {
      // A long tool call is still being written: show it moving.
      breakText(v);
      if (!v.argsRow || !v.argsRow.isConnected) { v.argsRow = add(v, el("div", "tool running argsrow")); v.argsRow.appendChild(el("span", "name", "")); v.argsRow.appendChild(el("span", "tool-args", "")); }
      const verb = m.name === "write_file" ? "writing" : m.name === "edit_file" ? "editing" : toolLabel(m.name);
      v.argsRow.firstChild.textContent = verb;
      v.argsRow.lastChild.textContent = (m.name === "write_file" || m.name === "edit_file" ? "file · " : "") + Number(m.chars || 0).toLocaleString() + " chars";
      if (v === active) stick();
      break;
    }
    case "tool": {
      breakText(v);
      if (v.argsRow) { v.argsRow.remove(); v.argsRow = null; }
      const d = el("details", "tool running");
      d._name = m.name;
      const summary = el("summary"); summary.appendChild(el("span", "name", toolLabel(m.name))); summary.appendChild(el("span", "tool-args", m.summary || ""));
      d._meta = el("span", "tool-meta"); summary.appendChild(d._meta);
      d.appendChild(summary);
      d.addEventListener("toggle", () => { if (d.open) fillTool(d); });
      v.curTool = d; addTool(v, d, m.name); break;
    }
    case "result": {
      breakText(v);
      const t = v.curTool;
      if (t) {
        t.classList.remove("running"); t.classList.add(m.err ? "failed" : "finished");
        t._bodyText = m.body || m.line || ""; t._err = !!m.err; t._diff = m.diff || null;
        if (m.diff) t._meta.appendChild(diffStat(m.diff));
        if (m.ms !== undefined) t._meta.appendChild(el("span", "dur", fmtDur(m.ms)));
        // Errors and short diffs open at once; long diffs stay collapsed.
        if (m.err || (m.diff && (m.diff.lines || []).length <= 30)) { fillTool(t); t.open = true; }
        const g = t.parentElement && t.parentElement.parentElement && t.parentElement.parentElement._group;
        if (g) g.update();
        v.curTool = null;
        if (v === active) stick();
      } else add(v, el("pre", "result" + (m.err ? " err" : ""), m.body || m.line));
      break;
    }
    case "plan": breakText(v); renderPlan(v, m); break;
    case "line": breakText(v); add(v, el("div", "line-" + m.kind, m.s)); break;
    case "turnend":
      breakText(v); settleTools(v); add(v, el("div", "turnend", "■ " + m.label));
      notify(v, "Done", m.label);
      break;
    case "busy": setBusy(v, m.label); break;
    case "confirm": {
      breakText(v);
      const box = el("div", "ask");
      box.appendChild(el("div", "asktitle", "Run this command?")); box.appendChild(el("div", "cmd code", m.command));
      if (m.reason) box.appendChild(el("div", "hint", m.reason));
      ["yes", "no", "always"].forEach((a) => {
        const b = el("button", a === "yes" ? "primary" : a === "no" ? "ghost" : "linkbtn", a === "yes" ? "Allow" : a === "no" ? "Deny" : "Always allow this program");
        b.type = "button";
        b.onclick = () => { post("/confirm", { sid: v.sid, id: m.id, answer: a }); box.remove(); };
        box.appendChild(b);
      });
      v.asks.set(m.id, box);
      add(v, box);
      notify(v, "Approval needed", m.command);
      break;
    }
    case "answered": {
      // The server settled this prompt (answered here, elsewhere, or cancelled).
      const box = v.asks.get(m.id);
      if (box) { box.remove(); v.asks.delete(m.id); }
      break;
    }
    case "select": {
      breakText(v);
      const anchor = m.via && v === active ? document.querySelector('#status [data-via="' + m.via + '"]') : null;
      if (anchor) { v.asks.set(m.id, openPicker(v, m, anchor)); break; }
      const box = selectBox(v, m);
      v.asks.set(m.id, box);
      add(v, box);
      if (!m.via) notify(v, "Choose: " + m.title, (m.options || []).slice(0, 4).map((o) => o.label).join(" · "));
      break;
    }
    case "select_update": { const box = v.asks.get(m.id); if (box && box.update) box.update(m.options); break; }
    case "prompt": {
      breakText(v);
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      const field = el("input", "askinput"); field.type = m.secret ? "password" : "text"; field.placeholder = m.placeholder || ""; field.spellcheck = false; field.autocomplete = "off";
      const send = (value) => { post("/prompt", { sid: v.sid, id: m.id, value: value }); box.remove(); };
      field.onkeydown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") { e.preventDefault(); send(field.value.trim() || null); }
        // Escape closes this box only; the page-level handler would cancel the whole turn.
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); send(null); }
      };
      box.appendChild(el("div")).appendChild(field);
      const ok = el("button", "primary", "OK"); ok.onclick = () => send(field.value.trim() || null); box.appendChild(ok);
      const cancel = el("button", "ghost", "Cancel"); cancel.onclick = () => send(null); box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box);
      if (v === active) field.focus();
      notify(v, m.title, m.placeholder || "");
      break;
    }
    case "termopen": ensureTermTab(v, m.tid, m.cwd); break;
    case "term": termWrite(v, m.tid, m.s); break;
    case "termdone": termDone(v, m.tid, m.code, m.cwd); break;
    case "termclosed": removeTermTab(v, m.tid); break;
  }
}

// An agent-initiated choice, in the transcript: grouped rows, ★ and a star button.
function selectBox(v, m) {
  const box = el("div", "ask");
  box.appendChild(el("div", "cmd", m.title));
  const rows = el("div", "ask-rows");
  box.appendChild(rows);
  const draw = (options) => {
    rows.innerHTML = "";
    let last = null;
    grouped(options.map((o, i) => Object.assign({ _i: i }, o))).forEach((o) => {
      if (o.group && o.group !== last) rows.appendChild(el("div", "ask-group", o.group));
      last = o.group;
      const line = el("div", "ask-row");
      if (m.star) {
        const st = el("button", "star" + (o.starred ? " on" : ""), o.starred ? "★" : "☆"); st.type = "button";
        st.title = o.starred ? "Unstar" : "Star"; st.setAttribute("aria-label", (o.starred ? "Unstar " : "Star ") + o.label);
        st.onclick = () => post("/select/star", { sid: v.sid, id: m.id, index: o._i }).then((r) => { if (r && r.options) draw(r.options); else toastError(r && r.error); });
        line.appendChild(st);
      }
      const b = el("button", "opt" + (o.current ? " current" : ""), (o.current ? "● " : "") + (o.starred && !m.star ? "★ " : "") + o.label);
      if (o.hint) b.appendChild(el("span", "hint", o.hint));
      b.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: o._i }); box.remove(); };
      line.appendChild(b);
      rows.appendChild(line);
    });
  };
  draw(m.options || []);
  box.update = draw;
  const cancel = el("button", "ghost", "Cancel");
  cancel.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: null }); box.remove(); };
  box.appendChild(cancel);
  return box;
}

// ---- chooser: a filterable, keyboard-driven list (pickers, the palette) ----
function chooser(opts) {
  const root = el("div", "chooser " + (opts.cls || ""));
  root.setAttribute("role", "dialog");
  if (opts.title) { root.setAttribute("aria-label", opts.title); root.appendChild(el("div", "chooser-title", opts.title)); }
  const field = el("input", "chooser-filter");
  field.placeholder = opts.placeholder || "Filter…"; field.spellcheck = false; field.autocomplete = "off"; field.setAttribute("aria-label", "Filter");
  const list = el("div", "chooser-list"); list.setAttribute("role", "listbox");
  root.appendChild(field); root.appendChild(list);
  if (opts.foot) root.appendChild(el("div", "chooser-foot", opts.foot));
  let items = opts.items || [], shown = [], sel = 0, rowsEls = [];
  const mark = () => {
    rowsEls.forEach((r, i) => { r.classList.toggle("sel", i === sel); r.setAttribute("aria-selected", i === sel ? "true" : "false"); });
    const r = rowsEls[sel];
    if (r) r.scrollIntoView({ block: "nearest" });
  };
  const render = (reset) => {
    const q = field.value.trim();
    shown = q ? rank(q, items, (it) => [it.label, it.keywords, it.hint, it.group]) : grouped(items);
    if (reset) sel = q ? 0 : Math.max(0, shown.findIndex((it) => it.current));
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    list.innerHTML = ""; rowsEls = [];
    let last = null;
    shown.forEach((it, i) => {
      if (!q && it.group && it.group !== last) list.appendChild(el("div", "chooser-group", it.group));
      last = it.group;
      const row = el("div", "chooser-row" + (it.current ? " current" : ""));
      row.setAttribute("role", "option");
      if (opts.onStar && !it.noStar) {
        const st = el("button", "star" + (it.starred ? " on" : ""), it.starred ? "★" : "☆"); st.type = "button"; st.tabIndex = -1;
        st.title = (it.starred ? "Unstar" : "Star") + " (ctrl+f)"; st.setAttribute("aria-label", (it.starred ? "Unstar " : "Star ") + it.label);
        st.onmousedown = (e) => e.preventDefault();
        st.onclick = (e) => { e.stopPropagation(); sel = i; opts.onStar(it); };
        row.appendChild(st);
      } else if (it.starred) row.appendChild(el("span", "star on", "★"));
      row.appendChild(el("span", "chooser-label", (it.current ? "● " : "") + it.label));
      if (it.hint) row.appendChild(el("span", "chooser-hint", it.hint));
      if (it.key) row.appendChild(el("kbd", "chooser-key", it.key));
      row.onmousemove = () => { if (sel !== i) { sel = i; mark(); } };
      row.onmousedown = (e) => e.preventDefault(); // keep focus in the filter
      row.onclick = () => choose(i);
      list.appendChild(row); rowsEls.push(row);
    });
    if (!shown.length) list.appendChild(el("div", "chooser-empty", "No matches"));
    mark();
  };
  let closed = false;
  const close = () => { if (closed) return; closed = true; document.removeEventListener("pointerdown", outside, true); root.remove(); if (opts.onClose) opts.onClose(); };
  const choose = (i) => { const it = shown[i]; if (!it) return; close(); opts.onChoose(it); };
  const cancel = () => { if (closed) return; close(); if (opts.onCancel) opts.onCancel(); };
  const outside = (e) => { if (!root.contains(e.target) && !(opts.keepOpen && opts.keepOpen(e.target))) cancel(); };
  field.oninput = () => render(true);
  field.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const page = Math.max(1, Math.floor(list.clientHeight / 30));
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); mark(); }
    else if (e.key === "PageDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + page); mark(); }
    else if (e.key === "PageUp") { e.preventDefault(); sel = Math.max(0, sel - page); mark(); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); sel = 0; mark(); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); sel = shown.length - 1; mark(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Tab") { e.preventDefault(); }
    else if (opts.onStar && e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); if (shown[sel]) opts.onStar(shown[sel]); }
  };
  render(true);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  return {
    root, field, cancel, close,
    get closed() { return closed; },
    setItems(next) { const keep = shown[sel]; items = next; render(false); if (keep) { const j = shown.findIndex((x) => x._i === keep._i && x.label === keep.label); if (j >= 0) { sel = j; mark(); } } },
  };
}

// A status-bar select as a popover anchored to its button.
let picker = null;
function closePicker(v) { if (picker && (!v || picker.v === v)) { picker.ch.cancel(); picker = null; } }
function openPicker(v, m, anchor) {
  if (picker) { picker.ch.close(); picker = null; }
  const toItems = (options) => options.map((o, i) => Object.assign({ _i: i }, o));
  let answered = false;
  const answer = (index) => { if (answered) return; answered = true; post("/select", { sid: v.sid, id: m.id, index }); };
  const ch = chooser({
    cls: "popover", title: m.title, items: toItems(m.options || []),
    placeholder: "Filter " + String(m.title || "").replace(/^select /i, "").toLowerCase() + "…",
    foot: "↑↓ move · enter choose · esc close" + (m.star ? " · ctrl+f star" : ""),
    onChoose: (it) => answer(it._i),
    onCancel: () => answer(null),
    onClose: () => { if (picker && picker.ch === ch) picker = null; input.focus({ preventScroll: true }); },
    onStar: m.star ? (it) => post("/select/star", { sid: v.sid, id: m.id, index: it._i }).then((r) => { if (r && r.options) ch.setItems(toItems(r.options)); else toastError(r && r.error); }) : null,
    keepOpen: (t) => anchor.contains(t),
  });
  document.body.appendChild(ch.root);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(440, window.innerWidth - 16);
  ch.root.style.width = w + "px";
  ch.root.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  ch.root.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + "px";
  ch.field.focus();
  picker = { v, ch };
  // What v.asks holds: the server settling the select closes the popover.
  return { remove() { answered = true; ch.close(); }, update(options) { ch.setItems(toItems(options)); } };
}

// ---- hub snapshot + sidebar ------------------------------------------------
// Hub snapshots come often (every status flip). The sidebar is rebuilt only
// when what it lists changed, and at most once a frame.
let hubSig = "", sidebarQueued = false;
function scheduleSidebar() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  const run = () => { if (sidebarQueued) renderSidebar(); };
  requestAnimationFrame(run);
  setTimeout(run, 150); // no frames in a background tab
}
function onHub(m) {
  const sig = JSON.stringify(m.workspaces);
  const same = sig === hubSig;
  hubSig = sig;
  hub = m;
  sessInfo.clear();
  for (const w of m.workspaces) for (const s of w.sessions) sessInfo.set(s.id, Object.assign({ workspace: w.path, wsname: w.name }, s));
  for (const v of views.values()) reconcileTerms(v);
  $("ver").textContent = "v" + m.version;
  renderUpdate(m.update);
  updAfterSnapshot();
  if (pendingSelect && sessInfo.has(pendingSelect)) { const id = pendingSelect; pendingSelect = null; show(id); }
  else if (!active) {
    const h = location.hash.slice(1);
    if (h && sessInfo.has(h)) select(h);
    else {
      const live = [...sessInfo.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      show(live ? live.id : null);
    }
  } else if (!sessInfo.has(active.sid) && !pendingSelect) show(null);
  if (!same) scheduleSidebar();
  renderCrumb(); renderTitle(); renderWelcome();
  markSeen();
}
function select(id) {
  const s = sessInfo.get(id);
  // Opening an archived session brings it back to the list.
  if (s && s.archivedAt) post("/sessions/archive", { id, archived: false });
  if (s && (!s.live || s.status === "error")) post("/sessions/resume", { id });
  show(id);
}
function show(sid) {
  if (active) {
    active.draft = input.value; saveDraft(active); active.scrollTop = logwrap.scrollTop;
    active.logEl.hidden = true;
  }
  active = sid ? getView(sid) : null;
  sb.keepUnread = null;
  $("welcome").hidden = !!active;
  $("bottom").hidden = !active;
  busyEl.hidden = !active;
  if (active) {
    active.logEl.hidden = false; active.unread = false;
    input.value = active.draft || ""; autoGrow(); menuIdx = 0; menuClosedFor = null; renderMenu();
    renderState(active);
    logwrap.scrollTop = active.followBottom ? logwrap.scrollHeight : active.scrollTop || 0;
    active.scrollTop = logwrap.scrollTop;
    renderBusy();
    if (location.hash !== "#" + sid) history.replaceState(null, "", "#" + sid);
    // On a narrow window the sidebar floats over the chat: tuck it away once
    // a session is picked.
    if (narrow()) setSide(true);
    input.focus({ preventScroll: true });
  } else {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    $("status").textContent = "";
  }
  if (!active) { menuCache = null; menu.style.display = "none"; }
  renderPanel(); renderSidebar(); renderCrumb(); renderTitle(); renderWelcome(); renderAttachments(); renderQueue();
  stick();
  markSeen();
}
function newSession(path) {
  post("/sessions/new", { workspace: path }).then((r) => { if (r.id) { pendingSelect = r.id; show(r.id); } else toastError(r.error); });
}
// Renaming a session in place. The sidebar is rebuilt on every hub update and
// on a timer, so the edit (which session, what is typed) lives here and each
// rebuild draws the field again instead of losing the typing.
let renaming = null;
let sidebarRebuilding = false;
// A press on a sidebar row has to reach that row. A rebuild between the press
// and its release (a rename saved on blur as the press moves focus, a hub
// update, the timer) replaces the row under the pointer, and the browser then
// drops the click. So rebuilds wait while a press is held and run once it is
// released, after the click.
let sidebarPressed = false, sidebarPending = false;
$("wslist").addEventListener("pointerdown", () => { sidebarPressed = true; }, true);
function releaseSidebar() {
  if (!sidebarPressed) return;
  sidebarPressed = false;
  if (sidebarPending) { sidebarPending = false; setTimeout(renderSidebar, 0); }
}
window.addEventListener("pointerup", releaseSidebar, true);
window.addEventListener("pointercancel", releaseSidebar, true);
// The window losing focus mid-press may swallow the release. Not captured:
// a captured blur would also fire for the rename field losing focus to the
// press, and release the hold before the click.
window.addEventListener("blur", (e) => { if (e.target === window) releaseSidebar(); });
function sidebarHeld() {
  if (sidebarPressed) sidebarPending = true;
  return sidebarPressed;
}
function startRename(id, title) {
  renaming = { id: id, value: title, fresh: true };
  renderSidebar();
}
function endRename(save) {
  const r = renaming;
  renaming = null;
  if (save && r && r.value.trim()) post("/sessions/rename", { id: r.id, title: r.value });
  renderSidebar();
}
function renameField(s) {
  const field = el("input", "stitle renaming");
  field.type = "text"; field.value = renaming.value; field.maxLength = 80; field.dir = "auto";
  field.setAttribute("aria-label", "New name for this session"); field.spellcheck = false;
  field.oninput = () => { renaming.value = field.value; };
  field.onclick = field.ondblclick = (e) => e.stopPropagation(); // not "open this session"
  field.onkeydown = (e) => {
    // While an IME is composing (Chinese, Japanese, Korean), Enter picks the
    // characters and Esc drops them: neither is ours, and neither may reach
    // the page. Safari reports the closing Enter only as keyCode 229.
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
    if (e.key === "Enter") { e.preventDefault(); endRename(true); }
    // Esc stops here: the page-level handler would read it as "cancel the turn".
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endRename(false); }
  };
  // Clicking away keeps what was typed, like any rename field.
  field.onblur = () => { if (sidebarRebuilding) return; if (renaming && renaming.id === s.id && document.hasFocus()) endRename(true); };
  setTimeout(() => {
    field.focus();
    if (renaming && renaming.fresh) { field.select(); renaming.fresh = false; } // first time: all selected; after a rebuild: the caret stays at the end
  }, 0);
  return field;
}
function renderSidebar() {
  if (sidebarHeld()) return;
  sidebarQueued = false;
  const list = $("wslist");
  // Removing a focused rename field fires blur in Chrome; that is a rebuild,
  // not the user clicking away, so renameField's blur handler skips it.
  sidebarRebuilding = true;
  list.innerHTML = "";
  sidebarRebuilding = false;
  sbOrder = [];
  renderSbChrome();
  if (sb.query) { renderResults(list); return; }
  const wss = sbWorkspaces();
  if (!wss.length) { list.appendChild(el("div", "sb-empty", "No projects yet")); return; }
  const shown = sb.filter ? wss.filter((w) => wkey(w.path) === sb.filter) : wss;
  const pinned = [], archived = [];
  for (const w of shown) for (const s of w.sessions) {
    if (sbHidden.has(s.id)) continue;
    if (s.archivedAt) archived.push({ s, w });
    else if (s.pinnedAt) pinned.push({ s, w });
  }
  pinned.sort((a, b) => a.s.pinnedAt - b.s.pinnedAt);
  archived.sort((a, b) => b.s.archivedAt - a.s.archivedAt);
  // With a Pinned shelf above them, the folders get a "Projects" label too, so
  // the two lists read as two sections; on their own they need none.
  if (pinned.length) {
    const shelf = el("div", "sb-pinned"); shelf.setAttribute("role", "group"); shelf.setAttribute("aria-label", "Pinned sessions");
    shelf.appendChild(sectionLabel("Pinned"));
    for (const x of pinned) shelf.appendChild(sessRow(x.s, x.w, true));
    list.appendChild(shelf);
    list.appendChild(sectionLabel("Projects"));
  }
  const folders = el("div", "sb-folders");
  for (const w of shown) folders.appendChild(folderEl(w));
  list.appendChild(folders);
  if (archived.length) list.appendChild(archiveShelf(archived));
}
// A quiet section label: 12px/500 muted text and a hairline rule to the edge.
function sectionLabel(text) {
  const d = el("div", "sb-section");
  d.appendChild(el("span", "sb-section-label", text));
  d.appendChild(el("span", "sb-rule"));
  return d;
}
// A folder: icon, name, (count and the most urgent status when collapsed),
// a "new session here" pen and the chevron; its sessions below.
function folderEl(w) {
  const key = wkey(w.path), collapsed = sb.collapsed.has(key);
  const sessions = w.sessions.filter((s) => !s.archivedAt && !s.pinnedAt && !sbHidden.has(s.id));
  const box = el("div", "ws sb-folder" + (collapsed ? " collapsed" : ""));
  const hdr = el("div", "wshdr sb-fhdr"); hdr.title = w.display || w.path;
  hdr.tabIndex = 0; hdr.setAttribute("role", "button"); hdr.setAttribute("aria-expanded", collapsed ? "false" : "true");
  hdr.appendChild(projIcon(w));
  hdr.appendChild(el("span", "wsname", w.name));
  if (w.pinnedAt) hdr.appendChild(glyph("pin", "sb-pinmark", "pinned"));
  hdr.appendChild(el("span", "grow"));
  if (collapsed && sessions.length) {
    hdr.appendChild(el("span", "sb-count", String(sessions.length)));
    const u = urgent(sessions);
    if (u) { const d = el("span", "sb-dot " + u.k + (u.pulse ? " pulse" : "")); d.appendChild(el("span", "sr-only", ", " + u.label.toLowerCase())); hdr.appendChild(d); }
  }
  const pen = iconBtn("pen", "New session in " + w.name, "sb-fnew");
  pen.onclick = (e) => { e.stopPropagation(); newSession(w.path); };
  hdr.appendChild(pen);
  hdr.appendChild(glyph("chev", "sb-chev"));
  const toggle = () => { if (sb.collapsed.has(key)) sb.collapsed.delete(key); else sb.collapsed.add(key); ls.set("smol.sb.collapsed", JSON.stringify([...sb.collapsed])); renderSidebar(); };
  hdr.onclick = toggle;
  hdr.onkeydown = (e) => {
    if (e.target !== hdr) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); const r = hdr.getBoundingClientRect(); projectMenu(w, { x: r.left + 24, y: r.bottom }, hdr); }
  };
  hdr.oncontextmenu = (e) => { e.preventDefault(); projectMenu(w, { x: e.clientX, y: e.clientY }, hdr); };
  // Drag a folder onto another to reorder (manual order, kept on the server).
  hdr.draggable = true;
  hdr.ondragstart = (e) => { sbDrag = w.path; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", w.name); } catch (err) {} };
  hdr.ondragend = () => { sbDrag = null; for (const n of document.querySelectorAll(".sb-fhdr.drop")) n.classList.remove("drop"); };
  hdr.ondragover = (e) => { if (!sbDrag || sbDrag === w.path) return; e.preventDefault(); hdr.classList.add("drop"); };
  hdr.ondragleave = () => hdr.classList.remove("drop");
  hdr.ondrop = (e) => { e.preventDefault(); hdr.classList.remove("drop"); if (sbDrag && sbDrag !== w.path) moveFolder(sbDrag, w.path); sbDrag = null; };
  box.appendChild(hdr);
  if (!collapsed) {
    const sl = el("div", "sessions");
    for (const s of sessions) sl.appendChild(sessRow(s, w, false));
    if (!sessions.length) {
      const b = el("button", "sb-newrow", "New session"); b.type = "button";
      b.onclick = () => newSession(w.path);
      sl.appendChild(b);
    }
    box.appendChild(sl);
  }
  return box;
}
// One session: a single 36px line on every shelf, so the list keeps one
// rhythm. Inside a folder the title is indented to line up with the folder's
// name; on the Pinned and Archived shelves (rows from many projects) the
// project icon sits in that indent instead. Then the title, the pin and
// worktree marks, and the status or time slot (actions on hover). Stored and
// seen sessions recede (400, muted); live and unread ones stand at 500. The
// branch and +N −M of the current session live in the top bar.
function sessRow(s, w, inPinned) {
  const v = views.get(s.id);
  const st = sStatus(s);
  const isActive = !!(active && active.sid === s.id);
  const recede = !!s.archivedAt || (!s.live && !s.unread);
  const row = el("div", "sess sb-row " + (s.live ? s.status : "stored") + (inPinned ? " sb-lead" : "") + (recede ? " recede" : "") + (isActive ? " active" : "") + (s.unread ? " unread" : "") + (s.archivedAt ? " archived" : ""));
  row.tabIndex = 0; row.dataset.sid = s.id;
  if (isActive) row.setAttribute("aria-current", "page");
  if (!s.archivedAt) sbOrder.push(s.id);
  const n = sbOrder.length;
  const hint = !s.archivedAt && n <= 9 ? el("kbd", "sb-hint", String(n)) : null;
  const titleEl = renaming && renaming.id === s.id ? renameField(s) : el("span", "stitle" + (s.title ? "" : " untitled"), s.title || "new session");
  const draft = !!((v && v.draft) || ls.get(draftKey(s.id))) && !isActive;
  const acts = rowActions(s, w, row);
  if (inPinned) { const ic = projIcon(w); ic.classList.add("sb-leadicon"); ic.title = w.name; row.appendChild(ic); }
  if (draft) row.appendChild(glyph("draft", "sb-draft", "unsent draft"));
  row.appendChild(titleEl);
  if (s.pinnedAt && !s.archivedAt && !inPinned) row.appendChild(glyph("pin", "sb-pinmark", "pinned"));
  if (s.worktree) {
    const git = s.git || {};
    const wt = glyph("branch", "sb-wtmark", "worktree " + (git.branch || s.worktree.branch || ""));
    wt.title = "Worktree branch " + (git.branch || s.worktree.branch || "");
    row.appendChild(wt);
  }
  const slot = st ? statusEl(st) : el("span", "stime", rel(s.archivedAt || s.updatedAt));
  row.appendChild(slot);
  row.appendChild(acts);
  if (hint) row.appendChild(hint);
  row.title = (s.title || "new session") + " · " + w.name + (s.model ? " · " + s.model : "") + (st ? " · " + st.label : s.live ? "" : " · saved — click to resume");
  row.onclick = () => select(s.id);
  row.ondblclick = () => startRename(s.id, s.title || "");
  row.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(s, w, { x: e.clientX, y: e.clientY }, row); };
  row.onkeydown = (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter") { e.preventDefault(); select(s.id); }
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); const r = row.getBoundingClientRect(); sessionMenu(s, w, { x: r.left + 24, y: r.bottom }, row); }
  };
  return row;
}
// Archive (or restore) and the more menu; shown on hover and focus.
function rowActions(s, w, row) {
  const acts = el("span", "sb-acts");
  const arch = s.archivedAt ? iconBtn("restore", "Restore session", "sb-act") : iconBtn("archive", "Archive session", "sb-act");
  arch.onclick = (e) => { e.stopPropagation(); if (s.archivedAt) restoreSession(s); else archiveSession(s); };
  const more = iconBtn("more", "More actions", "sb-act");
  more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); sessionMenu(s, w, { x: r.left, y: r.bottom + 4 }, more); };
  acts.appendChild(arch); acts.appendChild(more);
  return acts;
}
function archiveShelf(items) {
  const box = el("div", "sb-shelf" + (sb.archOpen ? " open" : ""));
  const hdr = el("button", "sb-shelfhdr"); hdr.type = "button"; hdr.setAttribute("aria-expanded", sb.archOpen ? "true" : "false");
  hdr.appendChild(el("span", "sb-section-label", "Archived")); hdr.appendChild(el("span", "grow"));
  hdr.appendChild(el("span", "sb-count", String(items.length))); hdr.appendChild(glyph("chev", "sb-chev"));
  hdr.onclick = () => { sb.archOpen = !sb.archOpen; ls.set("smol.sb.archOpen", sb.archOpen ? "1" : "0"); renderSidebar(); };
  box.appendChild(hdr);
  if (sb.archOpen) {
    const sl = el("div", "sessions");
    for (const x of items.slice(0, sb.archShow)) sl.appendChild(sessRow(x.s, x.w, true));
    box.appendChild(sl);
    const more = items.length - sb.archShow;
    if (more > 0) {
      const b = el("button", "sb-more", "Show " + Math.min(more, 25) + " more"); b.type = "button";
      b.onclick = () => { sb.archShow += 25; renderSidebar(); };
      box.appendChild(b);
    }
  }
  return box;
}
// Search: title matches first, then transcript matches with a snippet.
function renderResults(list) {
  const hits = sbSearchHits();
  const box = el("div", "sb-results"); box.setAttribute("role", "listbox"); box.setAttribute("aria-label", "Search results");
  if (!hits.length) { box.appendChild(el("div", "sb-noresults", sb.searching ? "Searching…" : "No sessions found")); list.appendChild(box); return; }
  if (sb.resultSel >= hits.length) sb.resultSel = hits.length - 1;
  hits.forEach((h, i) => {
    const row = el("div", "sess sb-result" + (i === sb.resultSel ? " sel" : "") + (active && active.sid === h.id ? " active" : "") + (h.archived ? " archived" : ""));
    row.setAttribute("role", "option"); row.setAttribute("aria-selected", i === sb.resultSel ? "true" : "false"); row.dataset.sid = h.id;
    // Same geometry as a shelf row: the project icon, then the title at the
    // shared 36px indent. Every result has a second line under the title:
    // the project, then the matching snippet when the match is in the text.
    const l1 = el("div", "sb-rline");
    const hw = hub.workspaces.find((w) => wkey(w.path) === wkey(h.workspace));
    const ic = hw ? projIcon(hw) : el("span", "sb-mono"); ic.classList.add("sb-leadicon"); l1.appendChild(ic);
    l1.appendChild(el("span", "stitle", h.title || "new session"));
    row.appendChild(l1);
    const sn = el("div", "sb-snippet");
    sn.appendChild(el("span", "sb-meta", (h.wsname || "") + (h.archived ? " · archived" : "")));
    if (h.where === "text" && h.snippet) {
      const m = h.match || [0, 0];
      sn.appendChild(document.createTextNode(" · " + h.snippet.slice(0, m[0])));
      sn.appendChild(el("mark", "", h.snippet.slice(m[0], m[0] + m[1])));
      sn.appendChild(document.createTextNode(h.snippet.slice(m[0] + m[1])));
    }
    row.appendChild(sn);
    row.onmousedown = (e) => e.preventDefault(); // keep focus in the field
    row.onclick = () => openResult(h);
    box.appendChild(row);
  });
  list.appendChild(box);
  const sel = box.children[sb.resultSel];
  if (sel) sel.scrollIntoView({ block: "nearest" });
}
function removeWorkspace(w) {
  if (w.sessions.some((s) => s.live)) { toastError("Close the open sessions in " + w.name + " first."); return; }
  const n = w.sessions.length;
  sbHiddenWs.add(w.path); renderSidebar(); renderWelcome();
  showUndo("Removed '" + w.name + "'" + (n ? " and " + n + " saved session" + (n > 1 ? "s" : "") : ""),
    () => { sbHiddenWs.delete(w.path); renderSidebar(); renderWelcome(); },
    { path: "/workspaces/remove", body: { path: w.path }, after: () => sbHiddenWs.delete(w.path) });
}
// ---- sidebar: state, ordering, status ---------------------------------------
// What must follow the user to another browser (pins, archive, unread, project
// order) lives on the hub; view preferences (collapsed folders, width, filter,
// sort) stay in this browser.
function lsJson(key, dflt) { try { const v = JSON.parse(ls.get(key) || "null"); return v === null ? dflt : v; } catch (e) { return dflt; } }
const sb = {
  query: "", results: null, searching: false, resultSel: 0, searchSeq: 0,
  collapsed: new Set(lsJson("smol.sb.collapsed", [])),
  archOpen: ls.get("smol.sb.archOpen") === "1", archShow: 10,
  filter: ls.get("smol.sb.filter") || null,
  sort: ls.get("smol.sb.sort") === "manual" ? "manual" : "recent",
  keepUnread: null, seenSent: new Map(),
};
let sbOrder = [];            // session ids in list order (Alt+↑/↓, Alt+1…9)
const sbHidden = new Set();  // sessions deleted but still undoable
const sbHiddenWs = new Set(); // projects removed but still undoable
let sbDrag = null;
function wkey(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function sbWorkspaces() {
  const list = hub.workspaces.filter((w) => !sbHiddenWs.has(w.path));
  const ord = (w) => (typeof w.order === "number" ? w.order : Infinity);
  return list.slice().sort((a, b) => {
    const pa = a.pinnedAt || 0, pb = b.pinnedAt || 0;
    if (!!pa !== !!pb) return pa ? -1 : 1;
    if (pa && pb && pa !== pb) return pa - pb;
    if (sb.sort === "manual" && ord(a) !== ord(b)) return ord(a) - ord(b);
    return (b.last || 0) - (a.last || 0);
  });
}
function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; }
// The status slot: a label and a dot, never colour alone. null = show the time.
function sStatus(s) {
  const failed = s.lastOutcome === "error";
  if (s.live) {
    if (s.status === "starting") return { k: "info", label: "Starting", pulse: true };
    if (s.status === "busy") return { k: "info", label: "Working", pulse: true, since: s.phaseSince };
    if (s.status === "waiting") return { k: "warning", label: "Needs you" };
    if (s.status === "error") return { k: "danger", label: "Failed" };
  }
  if (s.unread) return failed ? { k: "danger", label: "Failed" } : { k: "success", label: "Done" };
  return null;
}
// One dot for a collapsed folder: needs you, then failed, then done, then working.
function urgent(sessions) {
  const rank = { warning: 4, danger: 3, success: 2, info: 1 };
  let best = null;
  for (const s of sessions) { const st = sStatus(s); if (st && (!best || rank[st.k] > rank[best.k])) best = st; }
  return best;
}
function statusEl(st) {
  const box = el("span", "sb-status " + st.k);
  box.appendChild(el("span", "sb-dot " + st.k + (st.pulse ? " pulse" : "")));
  // The row keeps the label short so the title has room; how long it has
  // been working is the slot's tooltip (and the busy line in the chat).
  box.appendChild(el("span", "sb-label", st.label));
  if (st.since) { box.dataset.since = String(st.since); box.title = st.label + " for " + clock(Date.now() - st.since); }
  return box;
}
function midTrim(s, n) { s = String(s || ""); return s.length <= n ? s : s.slice(0, Math.ceil(n / 2) - 1) + "…" + s.slice(s.length - Math.floor(n / 2)); }
// Live durations tick without rebuilding the list.
setInterval(() => {
  for (const n of document.querySelectorAll("#wslist [data-since]")) n.title = "Working for " + clock(Date.now() - Number(n.dataset.since));
}, 1000);

// ---- sidebar: glyphs (Lucide-style strokes, inline, no assets) -------------
const SB_ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  folderplus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  pen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2 2 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  draft: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
};
function svgIcon(name) {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SB_ICONS[name] || "") + "</svg>";
}
function glyph(name, cls, label) {
  const g = el("span", "sb-glyph " + (cls || "")); g.innerHTML = svgIcon(name);
  if (label) g.appendChild(el("span", "sr-only", label));
  return g;
}
function iconBtn(name, label, cls) {
  const b = el("button", "sb-iconbtn " + (cls || "")); b.type = "button"; b.innerHTML = svgIcon(name);
  b.title = label; b.setAttribute("aria-label", label);
  b.onmousedown = (e) => e.stopPropagation();
  b.ondblclick = (e) => e.stopPropagation();
  return b;
}
// The project's favicon when the hub found one, else a tinted monogram.
function hashOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function monogram(w) {
  const m = el("span", "sb-mono h" + (hashOf(wkey(w.path)) % 5), (String(w.name || "?").replace(/^[^A-Za-z0-9]+/, "")[0] || "?").toUpperCase());
  m.setAttribute("aria-hidden", "true");
  return m;
}
function projIcon(w) {
  if (!w.icon) return monogram(w);
  const img = el("img", "sb-favicon"); img.alt = ""; img.width = 16; img.height = 16; img.decoding = "async";
  img.src = "/workspaces/icon?k=" + k + "&path=" + encodeURIComponent(w.path);
  img.onerror = () => img.replaceWith(monogram(w));
  return img;
}

// ---- sidebar: actions --------------------------------------------------------
function sessTitle(s) { return s.title || "new session"; }
function quoteTitle(s) { const t = sessTitle(s); return "'" + (t.length > 32 ? t.slice(0, 31) + "…" : t) + "'"; }
function archiveSession(s) {
  post("/sessions/archive", { id: s.id, archived: true }).then((r) => toastError(r && r.error));
  if (active && active.sid === s.id && s.live) show(null);
  showUndo("Archived " + quoteTitle(s), () => post("/sessions/archive", { id: s.id, archived: false }));
}
function restoreSession(s) {
  post("/sessions/archive", { id: s.id, archived: false }).then((r) => toastError(r && r.error));
}
function deleteSession(s) {
  sbHidden.add(s.id);
  if (active && active.sid === s.id) show(null); else renderSidebar();
  showUndo("Deleted " + quoteTitle(s), () => { sbHidden.delete(s.id); renderSidebar(); },
    { path: "/sessions/delete", body: { id: s.id }, after: () => sbHidden.delete(s.id) });
}
function pinSession(s, on) { post("/sessions/pin", { id: s.id, pinned: on }).then((r) => toastError(r && r.error)); }
function pinProject(w, on) { post("/workspaces/pin", { path: w.path, pinned: on }).then((r) => toastError(r && r.error)); }
function markUnread(s) {
  if (active && active.sid === s.id) sb.keepUnread = s.id;
  sb.seenSent.delete(s.id);
  post("/sessions/unread", { id: s.id }).then((r) => toastError(r && r.error));
}
// The current session was looked at: it is not unread any more (on the hub,
// so every browser agrees). Not while the tab is in the background.
function markSeen() {
  if (!active || document.hidden || sb.keepUnread === active.sid) return;
  const info = sessInfo.get(active.sid);
  if (!info || !info.unread) return;
  const at = info.lastTurnEndedAt || 0;
  if (sb.seenSent.get(info.id) === at) return;
  sb.seenSent.set(info.id, at);
  post("/sessions/seen", { id: info.id });
}
document.addEventListener("visibilitychange", markSeen);
window.addEventListener("focus", markSeen);
function moveFolder(from, to) {
  const order = sbWorkspaces().map((w) => w.path).filter((p) => p !== from);
  const i = order.indexOf(to);
  order.splice(i < 0 ? order.length : i, 0, from);
  sb.sort = "manual"; ls.set("smol.sb.sort", "manual");
  for (const w of hub.workspaces) w.order = order.indexOf(w.path);
  renderSidebar();
  post("/workspaces/order", { paths: order }).then((r) => toastError(r && r.error));
}
function curProject() {
  const info = active && sessInfo.get(active.sid);
  if (info) return info.workspace;
  const f = sb.filter && hub.workspaces.find((w) => wkey(w.path) === sb.filter);
  if (f) return f.path;
  const first = sbWorkspaces()[0];
  return first ? first.path : null;
}
function newSessionHere() { const p = curProject(); if (p) newSession(p); else openAddProject(); }
function sessFolder(s) { return s.worktree ? s.worktree.path : s.workspace; }

// ---- sidebar: undo notice ----------------------------------------------------
// Archive and delete happen at once; the notice offers Undo for 6 s (Ctrl+Z
// too). A delete is only sent to the hub when the notice goes away.
let sbUndo = null;
function showUndo(label, undo, commit) {
  flushUndo();
  const box = $("sbundo");
  box.innerHTML = "";
  box.appendChild(el("span", "sb-undomsg", label));
  const b = el("button", "sb-undobtn", "Undo"); b.type = "button"; b.title = "Undo (ctrl+z)";
  b.onclick = runUndo;
  box.appendChild(b);
  box.classList.add("on");
  sbUndo = { undo, commit, timer: setTimeout(flushUndo, 6000) };
}
function hideUndo() { const box = $("sbundo"); box.classList.remove("on"); setTimeout(() => { if (!sbUndo) box.innerHTML = ""; }, 220); }
function flushUndo(beacon) {
  const u = sbUndo;
  if (!u) return;
  sbUndo = null; clearTimeout(u.timer); hideUndo();
  if (!u.commit) return;
  if (beacon === true && navigator.sendBeacon) navigator.sendBeacon(u.commit.path + "?k=" + k, new Blob([JSON.stringify(u.commit.body)], { type: "application/json" }));
  else post(u.commit.path, u.commit.body).then((r) => { if (u.commit.after) u.commit.after(); toastError(r && r.error); keptNotice(r); renderSidebar(); });
}
// A delete never drops a worktree that holds work (changes, untracked or
// ignored files): the hub keeps it and says where.
function keptNotice(r) {
  const kept = !r || !r.kept ? [] : Array.isArray(r.kept) ? r.kept : [r.kept];
  for (const w of kept) {
    toast("Kept worktree at " + shortPath(w.path) + " because " + (w.reason || "it has changes"), { kind: "warn", ms: 15000, action: { label: "Copy path", run: () => copyText(w.path, "Path") } });
  }
}
function runUndo() {
  const u = sbUndo;
  if (!u) return false;
  sbUndo = null; clearTimeout(u.timer); hideUndo();
  u.undo();
  return true;
}
window.addEventListener("pagehide", () => flushUndo(true));

// ---- sidebar: menus ------------------------------------------------------------
let sbMenu = null;
function closeMenu() { if (sbMenu) sbMenu.close(false); }
function openMenu(items, pos, opener) {
  closeMenu();
  const m = el("div", "sb-menu"); m.setAttribute("role", "menu");
  const btns = [];
  for (const it of items) {
    if (it.sep) { m.appendChild(el("div", "sb-menu-sep")); continue; }
    const b = el("button", "sb-menu-item" + (it.danger ? " danger" : "")); b.type = "button"; b.setAttribute("role", "menuitem");
    b.appendChild(el("span", "sb-menu-label", it.label));
    if (it.aria) b.setAttribute("aria-label", it.aria);
    if (it.key) b.appendChild(el("kbd", "sb-menu-key", it.key));
    b.onclick = () => { close(false); it.run(); };
    b.onmousemove = () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); };
    m.appendChild(b); btns.push(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(pos.x, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(pos.y, window.innerHeight - r.height - 8)) + "px";
  const outside = (e) => { if (!m.contains(e.target)) close(false); };
  const onKey = (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); btns[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); btns[btns.length - 1].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") { e.preventDefault(); close(true); }
  };
  m.addEventListener("keydown", onKey);
  let closed = false;
  function close(refocus) {
    if (closed) return; closed = true;
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("blur", blurClose);
    m.remove(); if (sbMenu && sbMenu.m === m) sbMenu = null;
    if (refocus && opener && opener.isConnected) opener.focus({ preventScroll: true });
  }
  const blurClose = () => close(false);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  window.addEventListener("blur", blurClose);
  sbMenu = { m, close };
  if (btns[0]) btns[0].focus({ preventScroll: true });
  return sbMenu;
}
function sessionMenu(s, w, pos, opener) {
  const items = [
    { label: s.pinnedAt ? "Unpin" : "Pin", run: () => pinSession(s, !s.pinnedAt) },
    { label: "Rename", aria: "Rename session", key: "F2", run: () => startRename(s.id, s.title || "") },
    { label: "Mark unread", run: () => markUnread(s) },
    { sep: true },
    { label: "Copy path", run: () => copyText(sessFolder(s), "Path") },
    { label: "Copy session id", run: () => copyText(s.id, "Session id") },
    { label: "New session in " + w.name, key: ALT + "+N", run: () => newSession(w.path) },
    { label: "New session on a branch…", run: () => branchPrompt(w, pos) },
  ];
  if (s.live) items.push({ label: "Close session", run: () => post("/sessions/close", { id: s.id }) });
  items.push({ sep: true });
  items.push(s.archivedAt ? { label: "Restore", run: () => restoreSession(s) } : { label: "Archive", run: () => archiveSession(s) });
  items.push({ label: "Delete", danger: true, run: () => deleteSession(s) });
  openMenu(items, pos, opener);
}
function projectMenu(w, pos, opener) {
  const collapsed = sb.collapsed.has(wkey(w.path));
  openMenu([
    { label: "New session", run: () => newSession(w.path) },
    { label: "New session on a branch…", run: () => branchPrompt(w, pos) },
    { label: w.pinnedAt ? "Unpin project" : "Pin project", run: () => pinProject(w, !w.pinnedAt) },
    { label: sb.filter === wkey(w.path) ? "Show all projects" : "Show only this project", run: () => setFilter(sb.filter === wkey(w.path) ? null : wkey(w.path)) },
    { label: collapsed ? "Expand" : "Collapse", run: () => { if (collapsed) sb.collapsed.delete(wkey(w.path)); else sb.collapsed.add(wkey(w.path)); ls.set("smol.sb.collapsed", JSON.stringify([...sb.collapsed])); renderSidebar(); } },
    { label: "Copy path", run: () => copyText(w.path, "Path") },
    { sep: true },
    { label: "Remove from list", danger: true, run: () => removeWorkspace(w) },
  ], pos, opener);
}
// "New session on a branch": a git worktree of the project, on a new or
// existing branch. A small inline field (no prompt()).
function branchPrompt(w, pos) {
  closeMenu();
  const box = el("div", "sb-menu sb-branchbox"); box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "New session on a branch");
  box.appendChild(el("div", "sb-menu-title", "New session on a branch of " + w.name));
  const field = el("input", "sb-branchin"); field.placeholder = "branch name, e.g. fix-login"; field.spellcheck = false; field.autocomplete = "off"; field.setAttribute("aria-label", "Branch name");
  box.appendChild(field);
  box.appendChild(el("div", "sb-menu-hint", "Runs in its own git worktree · Enter to start · Esc to cancel"));
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(pos.x, window.innerWidth - r.width - 8)) + "px";
  box.style.top = Math.max(8, Math.min(pos.y, window.innerHeight - r.height - 8)) + "px";
  const outside = (e) => { if (!box.contains(e.target)) done(); };
  const done = () => { document.removeEventListener("pointerdown", outside, true); box.remove(); };
  field.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const branch = field.value.trim();
      if (!branch) return;
      field.disabled = true;
      post("/sessions/new", { workspace: w.path, branch }).then((res) => {
        if (res && res.id) { done(); pendingSelect = res.id; show(res.id); }
        else { field.disabled = false; field.focus(); toastError((res && res.error) || "Could not create the worktree"); }
      });
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  field.focus();
}
function setFilter(key) {
  sb.filter = key;
  if (key) ls.set("smol.sb.filter", key); else ls.del("smol.sb.filter");
  renderSidebar();
}
function openFilter(anchor) {
  if (picker) { picker.ch.close(); picker = null; }
  const items = [{ group: "Projects", label: "All projects", current: !sb.filter, run: () => setFilter(null) }];
  for (const w of sbWorkspaces()) items.push({ group: "Projects", label: w.name, hint: w.display, current: sb.filter === wkey(w.path), run: () => setFilter(wkey(w.path)) });
  items.push({ group: "Sort projects", label: "By recent activity", current: sb.sort === "recent", run: () => { sb.sort = "recent"; ls.set("smol.sb.sort", "recent"); renderSidebar(); } });
  items.push({ group: "Sort projects", label: "Manual (drag folders)", current: sb.sort === "manual", run: () => { sb.sort = "manual"; ls.set("smol.sb.sort", "manual"); renderSidebar(); } });
  const ch = chooser({ cls: "popover sb-filterpop", title: "Filter and sort", items, placeholder: "Filter projects…", onChoose: (it) => it.run(), onClose: () => { if (picker && picker.ch === ch) picker = null; }, keepOpen: (t) => anchor.contains(t) });
  document.body.appendChild(ch.root);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  ch.root.style.width = w + "px";
  ch.root.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  ch.root.style.top = (r.bottom + 6) + "px";
  ch.field.focus();
  picker = { v: null, ch };
}

// ---- sidebar: search -----------------------------------------------------------
// Titles are matched here at once; the hub adds transcript matches.
function sbSearchHits() {
  const q = sb.query.trim().toLowerCase();
  const names = new Map(hub.workspaces.map((w) => [wkey(w.path), w.name]));
  const local = [];
  for (const s of sessInfo.values()) if (!sbHidden.has(s.id) && sessTitle(s).toLowerCase().includes(q)) local.push({ id: s.id, title: s.title, workspace: s.workspace, where: "title", archived: !!s.archivedAt, updatedAt: s.updatedAt });
  local.sort((a, b) => (a.archived - b.archived) || (b.updatedAt - a.updatedAt));
  const seen = new Set(local.map((h) => h.id));
  const hits = local.slice();
  for (const h of (sb.results || [])) if (!seen.has(h.id) && !sbHidden.has(h.id) && sessInfo.has(h.id)) { seen.add(h.id); hits.push(h); }
  for (const h of hits) h.wsname = names.get(wkey(h.workspace)) || "";
  return hits.slice(0, 50);
}
let searchTimer = null, searchAbort = null;
function onSearchInput() {
  sb.query = $("sbsearch").value;
  sb.resultSel = 0;
  clearTimeout(searchTimer);
  // A newer query makes the one still running stale: the hub stops reading
  // transcripts for it once the request is gone.
  if (searchAbort) { searchAbort.abort(); searchAbort = null; }
  ++sb.searchSeq;
  if (!sb.query.trim()) { sb.results = null; sb.searching = false; sb.query = ""; renderSidebar(); return; }
  sb.searching = true;
  renderSidebar();
  const seq = sb.searchSeq, q = sb.query.trim();
  searchTimer = setTimeout(() => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    searchAbort = ctl;
    fetch("/sessions/search?k=" + k + "&q=" + encodeURIComponent(q), ctl ? { signal: ctl.signal } : undefined).then((r) => r.json()).catch(() => ({})).then((r) => {
      if (seq !== sb.searchSeq || (r && r.stale)) return;
      if (searchAbort === ctl) searchAbort = null;
      sb.results = (r && r.hits) || []; sb.searching = false;
      renderSidebar();
    });
  }, 150);
}
function clearSearch() { const f = $("sbsearch"); f.value = ""; onSearchInput(); }
function openResult(h) { clearSearch(); select(h.id); }

// ---- sidebar: chrome (header, undo notice, resize rail) ------------------------
// page.ts holds the shell; the sidebar's own controls are built here.
const sbHead = el("div", "sb-head");
const sbSearchWrap = el("label", "sb-search");
sbSearchWrap.appendChild(glyph("search", "sb-searchglyph"));
const sbSearch = el("input"); sbSearch.id = "sbsearch"; sbSearch.type = "search"; sbSearch.placeholder = "Search"; sbSearch.spellcheck = false; sbSearch.autocomplete = "off";
sbSearch.setAttribute("aria-label", "Search sessions");
sbSearchWrap.appendChild(sbSearch);
sbHead.appendChild(sbSearchWrap);
const sbFilterBtn = iconBtn("filter", "Filter by project", "sb-hbtn"); sbFilterBtn.id = "sbfilter";
sbFilterBtn.onclick = () => openFilter(sbFilterBtn);
const sbAddBtn = $("openfolder");
sbAddBtn.className = "sb-iconbtn sb-hbtn"; sbAddBtn.innerHTML = svgIcon("folderplus"); sbAddBtn.type = "button";
sbAddBtn.title = "Add project (ctrl+k)"; sbAddBtn.setAttribute("aria-label", "Add project");
const sbNewBtn = iconBtn("pen", "New session (" + ALT.toLowerCase() + "+n)", "sb-hbtn"); sbNewBtn.id = "sbnew";
sbNewBtn.onclick = newSessionHere;
sbHead.appendChild(sbFilterBtn); sbHead.appendChild(sbAddBtn); sbHead.appendChild(sbNewBtn);
sideEl.insertBefore(sbHead, $("wslist"));
const sbFilterBar = el("div", "sb-filterbar"); sbFilterBar.hidden = true;
sideEl.insertBefore(sbFilterBar, $("wslist"));
const sbUndoEl = el("div", "sb-undo"); sbUndoEl.id = "sbundo"; sbUndoEl.setAttribute("role", "status"); sbUndoEl.setAttribute("aria-live", "polite");
sideEl.insertBefore(sbUndoEl, sideEl.querySelector(".sidefoot"));
$("wslist").setAttribute("aria-label", "Projects and sessions");
sbSearch.addEventListener("input", onSearchInput);
sbSearch.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const hits = sb.query ? sbSearchHits() : [];
  if (e.key === "ArrowDown") { e.preventDefault(); if (hits.length) { sb.resultSel = (sb.resultSel + 1) % hits.length; renderSidebar(); } }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (hits.length) { sb.resultSel = (sb.resultSel - 1 + hits.length) % hits.length; renderSidebar(); } }
  else if (e.key === "Enter") { e.preventDefault(); const h = hits[sb.resultSel]; if (h) openResult(h); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (sbSearch.value) clearSearch(); else sbSearch.blur(); }
});
// The filter bar says when only one project is shown.
function renderSbChrome() {
  const f = sb.filter && hub.workspaces.find((w) => wkey(w.path) === sb.filter);
  if (sb.filter && hub.workspaces.length && !f) { sb.filter = null; ls.del("smol.sb.filter"); }
  sbFilterBar.hidden = !f || !!sb.query;
  sbFilterBtn.classList.toggle("on", !!f);
  if (f) {
    sbFilterBar.innerHTML = "";
    sbFilterBar.appendChild(el("span", "", "Only " + f.name));
    const b = el("button", "sb-linkbtn", "Show all"); b.type = "button"; b.onclick = () => setFilter(null);
    sbFilterBar.appendChild(b);
  }
}
// Resize rail: drag between 208px and the viewport minus 640px; double-click
// resets to 256px. The width is kept in this browser.
const SB_MIN = 208, SB_DEFAULT = 256;
function sbMax() { return Math.max(SB_MIN, window.innerWidth - 640); }
function setSideWidth(w, save) {
  const px = Math.round(Math.min(sbMax(), Math.max(SB_MIN, w)));
  sideEl.style.width = px + "px";
  sideEl.style.setProperty("--size-sidebar", px + "px");
  if (save) ls.set("smol.side.w", String(px));
  return px;
}
const sbRail = el("div", "sb-rail"); sbRail.id = "siderail";
sbRail.setAttribute("role", "separator"); sbRail.setAttribute("aria-orientation", "vertical"); sbRail.setAttribute("aria-label", "Resize sidebar"); sbRail.title = "Drag to resize · double-click to reset";
sideEl.appendChild(sbRail);
sbRail.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  sbRail.setPointerCapture(e.pointerId);
  document.body.classList.add("dragging", "sb-resizing");
  const left = sideEl.getBoundingClientRect().left;
  const move = (ev) => setSideWidth(ev.clientX - left, false);
  const up = (ev) => {
    sbRail.removeEventListener("pointermove", move); sbRail.removeEventListener("pointerup", up); sbRail.removeEventListener("pointercancel", up);
    document.body.classList.remove("dragging", "sb-resizing");
    setSideWidth(sideEl.getBoundingClientRect().width, true);
  };
  sbRail.addEventListener("pointermove", move); sbRail.addEventListener("pointerup", up); sbRail.addEventListener("pointercancel", up);
});
sbRail.addEventListener("dblclick", () => { setSideWidth(SB_DEFAULT, false); ls.del("smol.side.w"); });
window.addEventListener("resize", () => { if (sideEl.getBoundingClientRect().width > sbMax()) setSideWidth(sbMax(), false); });
setSideWidth(Number(ls.get("smol.side.w")) || SB_DEFAULT, false);

// ---- sidebar: keys ---------------------------------------------------------------
// Alt+N new session here, Alt+↑/↓ previous / next, Alt+1…9 jump (hints show
// while Alt is held), F2 rename, Ctrl+Z undo. Ctrl+N and Ctrl+1…9 are the browser's.
function editable(t) { return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))); }
function stepSession(d) {
  if (!sbOrder.length) return;
  const i = active ? sbOrder.indexOf(active.sid) : -1;
  const j = i < 0 ? (d > 0 ? 0 : sbOrder.length - 1) : Math.max(0, Math.min(sbOrder.length - 1, i + d));
  if (sbOrder[j] && (!active || sbOrder[j] !== active.sid)) select(sbOrder[j]);
}
// Is this an Alt shortcut, and not someone typing? Elsewhere Alt alone. On a
// Mac Option alone is typing in a text field, so there it takes Ctrl+Option
// (anywhere else on the page Option alone still works).
function altShortcut(e) {
  if (!e.altKey || e.metaKey) return false;
  if (!IS_MAC) return !e.ctrlKey;
  return e.ctrlKey || !editable(e.target);
}
function sidebarKey(e) {
  if (altShortcut(e)) {
    if (e.key === "Alt" || e.key === "Control") { sideEl.classList.add("alt-held"); return false; }
    if (e.code === "KeyN" && !e.shiftKey) { e.preventDefault(); newSessionHere(); return true; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); stepSession(e.key === "ArrowUp" ? -1 : 1); return true; }
    const dg = /^Digit([1-9])$/.exec(e.code || "");
    if (dg) { e.preventDefault(); const id = sbOrder[Number(dg[1]) - 1]; if (id) select(id); return true; }
  }
  if (e.key === "F2" && !e.altKey && !e.ctrlKey && !e.metaKey && (!editable(e.target) || e.target === input)) {
    const row = e.target && e.target.closest && e.target.closest("#wslist .sess");
    const id = row ? row.dataset.sid : active && active.sid;
    const s = id && sessInfo.get(id);
    if (s) { e.preventDefault(); startRename(s.id, s.title || ""); return true; }
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && sbUndo && !editable(e.target)) {
    e.preventDefault(); runUndo(); return true;
  }
  return false;
}
document.addEventListener("keyup", (e) => { if (e.key === "Alt" || !altShortcut(e)) sideEl.classList.remove("alt-held"); });
window.addEventListener("blur", () => sideEl.classList.remove("alt-held"));

// ---- add project: a typed path with a live folder listing --------------------
// Empty: recent projects and suggested folders next to them. Typing a path
// lists matching folders; Tab completes the highlighted one, ".." goes up,
// Enter adds it and starts a session.
let addProj = null, suggestCache = null;
function openAddProject(start) {
  if (addProj) { addProj.field.focus(); return; }
  closeMenu(); closePicker(null);
  if (palette) palette.ch.close();
  const back = el("div", "palette-backdrop sb-addback");
  const root = el("div", "chooser palette sb-addproj"); root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Add project");
  root.appendChild(el("div", "chooser-title", "Add project"));
  const field = el("input", "chooser-filter"); field.placeholder = "Type a folder path, e.g. ~/code/app"; field.spellcheck = false; field.autocomplete = "off"; field.setAttribute("aria-label", "Folder path");
  const list = el("div", "chooser-list"); list.setAttribute("role", "listbox");
  root.appendChild(field); root.appendChild(list);
  root.appendChild(el("div", "chooser-foot", "↑↓ move · tab complete · enter add · esc close"));
  back.appendChild(root);
  document.body.appendChild(back);
  let rows = [], sel = 0, seq = 0, listing = null;
  const sep = hub.sep || "/";
  const draw = () => {
    list.innerHTML = "";
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    let last = null;
    rows.forEach((r, i) => {
      if (r.group && r.group !== last) list.appendChild(el("div", "chooser-group", r.group));
      last = r.group;
      const row = el("div", "chooser-row" + (i === sel ? " sel" : "")); row.setAttribute("role", "option"); row.setAttribute("aria-selected", i === sel ? "true" : "false");
      row.appendChild(el("span", "chooser-label", r.label));
      if (r.hint) row.appendChild(el("span", "chooser-hint", r.hint));
      row.onmousemove = () => { if (sel !== i) { sel = i; draw(); } };
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => runRow(r);
      list.appendChild(row);
    });
    if (!rows.length) list.appendChild(el("div", "chooser-empty", listing && listing.error ? listing.error : "No folders here"));
    const s = list.querySelector(".chooser-row.sel"); if (s) s.scrollIntoView({ block: "nearest" });
  };
  const idle = () => {
    rows = [];
    const known = hub.workspaces.slice().sort((a, b) => (b.lastOpened || b.last || 0) - (a.lastOpened || a.last || 0)).slice(0, 8);
    for (const w of known) rows.push({ group: "Recent", label: w.name, hint: w.display, run: () => newSession(w.path) });
    for (const d of (suggestCache || []).slice(0, 8)) rows.push({ group: "Suggested", label: d.name, hint: d.display, add: d.path });
    rows.push({ group: "More", label: "Browse folders…", hint: "pick a folder in a dialog", run: () => openDialog() });
    draw();
  };
  const refresh = () => {
    const q = field.value;
    if (!q.trim()) { seq++; listing = null; idle(); return Promise.resolve(); }
    const mine = ++seq;
    return fetch("/fs?k=" + k + "&complete=1&path=" + encodeURIComponent(q)).then((r) => r.json()).catch(() => ({ error: "cannot list folders" })).then((d) => {
      if (mine !== seq || !addProj) return;
      listing = d; rows = [];
      if (!d.error && !d.prefix) rows.push({ group: "", label: "Add " + (String(d.path).split(/[\\/]/).filter(Boolean).pop() || d.path), hint: (d.display || d.path) + (d.project ? " · project" : ""), add: d.path });
      if (!d.error && d.parent && !d.prefix) rows.push({ group: "", label: "..", hint: "up one folder", folder: d.parent });
      for (const dir of (d.dirs || []).slice(0, 200)) rows.push({ group: "", label: dir.name + sep, hint: dir.project ? "project" : "", folder: dir.path, add: dir.path });
      sel = 0; draw();
    });
  };
  const complete = (r) => { if (!r || !r.folder) return; field.value = r.folder.replace(/[\\/]+$/, "") + sep; refresh(); };
  const close = () => { if (!addProj) return; addProj = null; back.remove(); if (active) input.focus({ preventScroll: true }); };
  const addFolder = (p) => {
    post("/workspaces/add", { path: p, start: true }).then((r) => {
      if (r.error) { toastError(r.error); return; }
      close();
      if (r.id) { pendingSelect = r.id; show(r.id); }
    });
  };
  function runRow(r) {
    if (!r) return;
    if (r.run) { close(); r.run(); }
    else if (r.add && !(r.label === ".." )) addFolder(r.add);
    else if (r.folder) complete(r);
  }
  // Typing asks the hub at most every 120ms. Tab or Enter while a listing is
  // still due waits for it, so they act on what was typed, not the old list.
  let typeTimer = null, due = null;
  const flush = () => { if (!typeTimer) return due || Promise.resolve(); clearTimeout(typeTimer); typeTimer = null; return (due = refresh()); };
  field.oninput = () => {
    clearTimeout(typeTimer); typeTimer = null;
    if (!field.value.trim()) { due = refresh(); return; }
    typeTimer = setTimeout(() => { typeTimer = null; due = refresh(); }, 120);
  };
  const tab = () => { const r = rows[sel]; if (r && r.folder) complete(r); else if (r && r.add && !field.value.trim()) { field.value = r.add.replace(/[\\/]+$/, "") + sep; refresh(); } };
  field.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, rows.length); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + rows.length) % Math.max(1, rows.length); draw(); }
    else if (e.key === "Tab") { e.preventDefault(); if (typeTimer) flush().then(tab); else tab(); }
    else if (e.key === "Enter") { e.preventDefault(); if (typeTimer) flush().then(() => runRow(rows[sel])); else runRow(rows[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  back.onpointerdown = (e) => { if (e.target === back) close(); };
  addProj = { field, close };
  if (start) { field.value = start; refresh(); } else idle();
  field.focus();
  if (!suggestCache) fetch("/workspaces/suggest?k=" + k).then((r) => r.json()).catch(() => ({})).then((r) => { suggestCache = (r && r.dirs) || []; if (addProj && !field.value.trim()) idle(); });
}
sbAddBtn.onclick = () => openAddProject();
function renderCrumb() {
  const c = $("crumb");
  c.innerHTML = "";
  if (!active) { c.appendChild(el("span", "ws", "smolcoder")); c.title = ""; return; }
  const info = sessInfo.get(active.sid);
  c.appendChild(el("span", "ws", info ? info.wsname : ""));
  c.appendChild(el("span", "sep", "›"));
  c.appendChild(el("span", "title", active.state.title || (info && info.title) || "new session"));
  c.title = info ? info.workspace : "";
  // The checkout this session works in: its branch and uncommitted +N −M.
  const w = info && hub.workspaces.find((x) => wkey(x.path) === wkey(info.workspace));
  const git = info && (info.git || (w && w.git));
  if (git && git.branch) {
    const g = el("span", "crumb-git");
    g.title = (info.worktree ? "worktree branch " : "branch ") + git.branch + (git.added || git.removed ? " · uncommitted changes" : "");
    g.appendChild(glyph("branch", "crumb-branchglyph"));
    g.appendChild(el("span", "crumb-branch", midTrim(git.branch, 36)));
    if (git.added || git.removed) {
      const d = el("span", "sb-diff");
      d.appendChild(el("span", "add", "+" + git.added)); d.appendChild(el("span", "del", "−" + git.removed));
      g.appendChild(d);
    }
    c.appendChild(g);
  }
}
function renderTitle() {
  let busy = false, waiting = false;
  for (const s of sessInfo.values()) { if (s.status === "busy" || s.status === "starting") busy = true; if (s.status === "waiting") waiting = true; }
  const info = active && sessInfo.get(active.sid);
  document.title = (waiting ? "⚠ " : busy ? "● " : "") + (info ? (info.title || info.wsname) + " · " : "") + "smol";
}
function renderWelcome() {
  const w = $("welcome");
  w.hidden = !!active;
  if (active) return;
  // Two empty states: no projects yet, or projects but no session picked.
  // The logo above them stays either way.
  const ws = sbWorkspaces().slice(0, 8);
  const h1 = w.querySelector("h1"), btn = $("welcomeopen");
  let sub = h1 && h1.nextElementSibling && h1.nextElementSibling.tagName === "P" ? h1.nextElementSibling : null;
  if (!sub && h1) { sub = el("p", "sb-welcome-sub"); h1.insertAdjacentElement("afterend", sub); }
  if (h1) h1.textContent = ws.length ? "Pick a session to continue" : "What should we work on?";
  if (sub) sub.textContent = ws.length ? "Choose one in the sidebar, or start a new one." : "Add a project folder to start your first session.";
  btn.textContent = ws.length ? "New session" : "Add project";
  btn.className = ws.length ? "ghost" : "primary";
  btn.onclick = ws.length ? newSessionHere : () => openAddProject();
  const r = $("recent");
  r.innerHTML = "";
  if (!ws.length) return;
  r.appendChild(el("div", "recent-label", "Recent"));
  for (const x of ws) {
    const b = el("button", "wsbtn");
    b.appendChild(el("span", "", x.name)); b.appendChild(el("span", "dim", "  " + x.display));
    b.title = "New session in " + x.name;
    b.onclick = () => newSession(x.path);
    r.appendChild(b);
  }
}
setInterval(() => { renderSidebar(); }, 30000);

// ---- folder picker --------------------------------------------------------
let fsState = { path: "", parent: null };
function openDialog(start) {
  $("modal").hidden = false;
  browse(start || (active && active.state.workspace) || "");
  setTimeout(() => $("fspath").focus(), 0);
}
function closeDialog() { $("modal").hidden = true; }
function browse(p) {
  fetch("/fs?k=" + k + "&path=" + encodeURIComponent(p || "")).then((r) => r.json()).then(renderFs).catch(() => {});
}
function renderFs(d) {
  const list = $("fslist");
  list.innerHTML = "";
  const roots = $("fsroots");
  roots.innerHTML = "";
  const chip = (label, p) => { const c = el("span", "chip", label); c.onclick = () => browse(p); roots.appendChild(c); };
  chip("~ home", d.home);
  for (const r of d.roots || []) chip(r, r);
  if (d.error) { $("fspath").value = d.path || ""; list.appendChild(el("div", "sidehint", d.error)); $("fsopen").disabled = true; return; }
  $("fsopen").disabled = false;
  fsState = d;
  $("fspath").value = d.path;
  $("fsopen").textContent = "Open " + (d.path.split(/[\\/]/).filter(Boolean).pop() || d.path) + (d.project ? " ✦" : "");
  if (d.parent) { const up = el("div", "fsitem up", "↑ .."); up.onclick = () => browse(d.parent); list.appendChild(up); }
  for (const dir of d.dirs) {
    const it = el("div", "fsitem");
    it.appendChild(el("span", "", dir.name + "/"));
    if (dir.project) it.appendChild(el("span", "proj", "✦ project"));
    it.onclick = () => browse(dir.path);
    it.ondblclick = () => openFolder(dir.path);
    list.appendChild(it);
  }
  if (!d.dirs.length) list.appendChild(el("div", "sidehint", "no subfolders"));
}
function openFolder(p) {
  post("/workspaces/add", { path: p, start: $("fsstart").checked }).then((r) => {
    if (r.error) { toastError(r.error); return; }
    closeDialog();
    if (r.id) { pendingSelect = r.id; show(r.id); }
  });
}
$("fsclose").onclick = closeDialog;
$("modal").onclick = (e) => { if (e.target === $("modal")) closeDialog(); };
$("fsgo").onclick = () => browse($("fspath").value);
$("fspath").onkeydown = (e) => { if (e.key === "Enter") browse($("fspath").value); };
$("fsopen").onclick = () => openFolder(fsState.path);

// ---- right panel: browser + terminal tabs ---------------------------------
let panelWidth = Math.max(300, Number(ls.get("smol.panel.w")) || 520);
function panelKey(v) { return "smol.panel." + v.sid; }
function savePanel(v) {
  ls.set(panelKey(v), JSON.stringify({ open: v.panelOpen, active: v.activeTab, tabs: v.tabs.filter((t) => t.kind === "browser").map((t) => ({ kind: "browser", url: t.url })) }));
}
function loadPanelState(v) {
  try {
    const st = JSON.parse(ls.get(panelKey(v)) || "null");
    if (!st) return;
    for (const t of st.tabs || []) {
      if (t.kind !== "browser") continue;
      const tab = { kind: "browser", url: t.url || "", id: uid() };
      buildBrowserTab(v, tab); v.tabs.push(tab);
    }
    v.panelOpen = !!st.open;
    v.activeTab = st.active || (v.tabs[0] && v.tabs[0].id) || null;
  } catch (e) {}
}
function curTab(v) { return v.tabs.find((t) => t.id === v.activeTab) || v.tabs[0] || null; }
function renderPanel() {
  const v = active;
  const open = !!(v && v.panelOpen && v.tabs.length);
  panelEl.hidden = !open;
  const cur = open ? curTab(v) : null;
  $("btnbrowser").classList.toggle("on", !!(cur && cur.kind === "browser"));
  $("btnterm").classList.toggle("on", !!(cur && cur.kind === "term"));
  for (const o of views.values()) o.panelEl.hidden = o !== v || !open;
  if (!open) return;
  // Never let the panel squeeze the chat below ~40% of a small window.
  panelEl.style.width = Math.min(panelWidth, Math.max(300, window.innerWidth * 0.6)) + "px";
  tabsEl.innerHTML = "";
  for (const t of v.tabs) {
    const b = el("div", "ptab" + (t === cur ? " on" : ""));
    b.appendChild(el("span", "ico", t.kind === "browser" ? "◎" : ">_"));
    b.appendChild(el("span", "lbl", t.kind === "browser" ? (t.url ? t.url.replace(/^https?:\/\//, "") : "new tab") : "terminal " + t.tid.replace(/^t/, "")));
    const x = el("span", "x", "×"); x.title = "close tab";
    x.onclick = (e) => { e.stopPropagation(); closeTab(v, t); };
    b.appendChild(x);
    b.onclick = () => { v.activeTab = t.id; savePanel(v); renderPanel(); if (t.kind === "term" && t.inp) t.inp.focus(); };
    b.title = t.kind === "browser" ? (t.url || "new browser tab") : "terminal in " + shortPath(t.cwd);
    tabsEl.appendChild(b);
  }
  tabsEl.appendChild(el("span", "grow"));
  const nb = el("button", "iconbtn", "+◎"); nb.title = "new browser tab"; nb.onclick = () => openBrowserTab(v);
  const nt = el("button", "iconbtn", "+>_"); nt.title = "new terminal"; nt.onclick = () => openTerminalTab(v);
  const cl = el("button", "iconbtn", "»"); cl.title = "hide panel"; cl.onclick = () => { v.panelOpen = false; savePanel(v); renderPanel(); };
  tabsEl.appendChild(nb); tabsEl.appendChild(nt); tabsEl.appendChild(cl);
  for (const t of v.tabs) if (t.el) t.el.hidden = t !== cur;
}
function closeTab(v, t) {
  const i = v.tabs.indexOf(t);
  if (t.kind === "term") { post("/term/close", { sid: v.sid, tid: t.tid }); removeTermTab(v, t.tid); return; }
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v); renderPanel();
}
function togglePanelKind(kind) {
  const v = active;
  if (!v) return;
  const cur = curTab(v);
  if (v.panelOpen && cur && cur.kind === kind) { v.panelOpen = false; savePanel(v); renderPanel(); return; }
  const existing = v.tabs.filter((t) => t.kind === kind).pop();
  if (existing) {
    v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (kind === "term" && existing.inp) existing.inp.focus();
  } else if (kind === "browser") openBrowserTab(v);
  else openTerminalTab(v);
}
$("btnbrowser").onclick = () => togglePanelKind("browser");
$("btnterm").onclick = () => togglePanelKind("term");

// browser tabs
function fillUrls(t, urls) {
  if (!t.dl) return;
  const cur = [...t.dl.options].map((o) => o.value).join("|");
  if (cur === urls.join("|")) return;
  t.dl.innerHTML = "";
  for (const u of urls) { const o = document.createElement("option"); o.value = u; t.dl.appendChild(o); }
  t.urlsEl.innerHTML = "";
  if (urls.length && !t.url) {
    t.urlsEl.appendChild(el("div", "hint", "dev servers the agent started:"));
    for (const u of urls) { const b = el("button", "ghost", u); b.onclick = () => t.nav(u); t.urlsEl.appendChild(b); }
  }
}
function openBrowserTab(v, url) {
  const t = { kind: "browser", url: "", id: uid() };
  buildBrowserTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true;
  const start = url || (v.state.urls && v.state.urls[0]) || "";
  if (start) t.nav(start); else { savePanel(v); renderPanel(); t.urlIn.focus(); }
}
function buildBrowserTab(v, t) {
  const body = el("div", "tabbody browser"); body.hidden = true;
  const bar = el("div", "bar");
  const reload = el("button", "iconbtn", "↻"); reload.title = "reload";
  const urlIn = document.createElement("input"); urlIn.placeholder = "http://localhost:5173"; urlIn.spellcheck = false;
  const dlId = "dl_" + t.id; const dl = document.createElement("datalist"); dl.id = dlId; urlIn.setAttribute("list", dlId);
  const go = el("button", "iconbtn", "→"); go.title = "go";
  const ext = el("a", "iconbtn", "↗"); ext.title = "open in a new browser tab"; ext.target = "_blank"; ext.rel = "noopener";
  bar.appendChild(reload); bar.appendChild(urlIn); bar.appendChild(dl); bar.appendChild(go); bar.appendChild(ext);
  const empty = el("div", "empty");
  empty.appendChild(el("div", "", "Enter a URL to preview it here."));
  const urlsEl = el("div", "urls"); empty.appendChild(urlsEl);
  const frame = document.createElement("iframe"); frame.hidden = true;
  // Games need pointer lock; confirmation dialogs must reach the user.
  // Keep navigation to the harness origin blocked below.
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-modals");
  frame.referrerPolicy = "no-referrer";
  frame.title = "App preview";
  body.appendChild(bar); body.appendChild(empty); body.appendChild(frame);
  v.panelEl.appendChild(body);
  t.el = body; t.frame = frame; t.urlIn = urlIn; t.dl = dl; t.urlsEl = urlsEl;
  t.nav = (u) => {
    u = (u || "").trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
    let parsed;
    try { parsed = new URL(u); } catch { urlIn.setCustomValidity("Enter a valid http or https URL"); urlIn.reportValidity(); return; }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin === location.origin || (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.port === location.port)) {
      urlIn.setCustomValidity("Preview a separate app using http or https"); urlIn.reportValidity(); return;
    }
    urlIn.setCustomValidity(""); u = parsed.href;
    t.url = u; urlIn.value = u; ext.href = u;
    frame.src = u; frame.hidden = false; empty.hidden = true;
    savePanel(v); renderPanel();
  };
  go.onclick = () => t.nav(urlIn.value);
  urlIn.onkeydown = (e) => { if (e.key === "Enter") t.nav(urlIn.value); };
  reload.onclick = () => { if (t.url) frame.src = t.url; };
  fillUrls(t, v.state.urls || []);
  if (t.url) t.nav(t.url);
}

// terminal tabs
function ensureTermTab(v, tid, cwd) {
  let t = v.terms.get(tid);
  if (t) { if (cwd) setPrompt(t, cwd); return t; }
  t = { kind: "term", tid, id: "t:" + tid, cwd: cwd || "", history: [], hi: 0, lines: 0, cur: null };
  const body = el("div", "tabbody term"); body.hidden = true;
  const out = el("pre", "out");
  const row = el("div", "trow");
  const prompt = el("span", "prompt");
  const inp = document.createElement("input");
  inp.placeholder = "Run a command…"; inp.title = "Enter to run · Ctrl+C to interrupt · Ctrl+L to clear"; inp.setAttribute("aria-label", "Terminal command"); inp.spellcheck = false; inp.autocomplete = "off";
  inp.onkeydown = (e) => {
    if (e.key === "Enter") {
      const text = inp.value;
      if (!text.trim()) return;
      inp.value = "";
      if (t.history[t.history.length - 1] !== text) t.history.push(text);
      t.hi = t.history.length;
      post("/term/input", { sid: v.sid, tid, text });
    } else if (e.key === "c" && e.ctrlKey && !String(window.getSelection())) { e.preventDefault(); post("/term/interrupt", { sid: v.sid, tid }); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); out.innerHTML = ""; t.cur = null; t.lines = 0; }
    else if (e.key === "ArrowUp") { if (t.hi > 0) { t.hi--; inp.value = t.history[t.hi]; } e.preventDefault(); }
    else if (e.key === "ArrowDown") { if (t.hi < t.history.length - 1) { t.hi++; inp.value = t.history[t.hi]; } else { t.hi = t.history.length; inp.value = ""; } e.preventDefault(); }
  };
  out.onclick = () => { if (!String(window.getSelection())) inp.focus(); };
  row.appendChild(prompt); row.appendChild(inp);
  body.appendChild(out); body.appendChild(row);
  v.panelEl.appendChild(body);
  t.el = body; t.out = out; t.inp = inp; t.promptEl = prompt;
  setPrompt(t, cwd || "");
  v.terms.set(tid, t); v.tabs.push(t);
  if (!v.activeTab) v.activeTab = t.id;
  if (v === active) renderPanel();
  return t;
}
function setPrompt(t, cwd) { t.cwd = cwd; t.promptEl.textContent = (shortPath(cwd) || "…") + " ❯"; t.promptEl.title = cwd; }
function termWrite(v, tid, text) {
  const t = v.terms.get(tid) || ensureTermTab(v, tid, "");
  const out = t.out;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i];
    if (i > 0) t.cur = null;
    if (!t.cur) { t.cur = el("div", "l"); out.appendChild(t.cur); t.lines++; }
    const cr = seg.lastIndexOf("\r");
    if (cr >= 0) { t.cur.innerHTML = ""; seg = seg.slice(cr + 1); }
    if (seg) t.cur.appendChild(ansiToFrag(seg));
  }
  while (t.lines > 4000 && out.firstChild) { out.removeChild(out.firstChild); t.lines--; }
  if (nearBottom) out.scrollTop = out.scrollHeight;
}
function termDone(v, tid, code, cwd) {
  const t = v.terms.get(tid);
  if (!t) return;
  if (cwd) setPrompt(t, cwd);
  if (t.cur && t.cur.textContent) termWrite(v, tid, "\n");
  if (code) termWrite(v, tid, "\x1b[2m[exit " + code + "]\x1b[0m\n");
}
function removeTermTab(v, tid) {
  const t = v.terms.get(tid);
  if (!t) return;
  v.terms.delete(tid);
  const i = v.tabs.indexOf(t);
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v);
  if (v === active) renderPanel();
}
function reconcileTerms(v) {
  const info = sessInfo.get(v.sid);
  const alive = new Set(info && info.live ? info.terminals.map((x) => x.tid) : []);
  for (const tid of [...v.terms.keys()]) if (!alive.has(tid)) removeTermTab(v, tid);
  if (info && info.live) for (const x of info.terminals) ensureTermTab(v, x.tid, x.cwd);
}
function openTerminalTab(v) {
  post("/term/open", { sid: v.sid }).then((r) => {
    if (!r.tid) { toastError(r.error || "Could not open a terminal"); return; }
    const t = ensureTermTab(v, r.tid, r.cwd);
    v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel();
    t.inp.focus();
  });
}

// resize grip
$("panelgrip").onmousedown = (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
  const move = (ev) => { panelWidth = Math.min(window.innerWidth * 0.8, Math.max(300, window.innerWidth - ev.clientX)); panelEl.style.width = panelWidth + "px"; };
  const up = () => { document.body.classList.remove("dragging"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); ls.set("smol.panel.w", String(Math.round(panelWidth))); };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
};

// ---- sidebar collapse -----------------------------------------------------
function setSide(collapsed) {
  sideEl.classList.toggle("collapsed", collapsed);
  $("sidetoggle").hidden = !collapsed;
  // Narrow windows: the open sidebar floats over a scrim (CSS shows it only
  // there); a click on it, or Esc, closes the sidebar.
  $("sidescrim").hidden = collapsed;
  ls.set("smol.side", collapsed ? "1" : "0");
}
function narrow() { return window.matchMedia("(max-width: 1000px)").matches; }
function sideOverlayOpen() { return narrow() && !sideEl.classList.contains("collapsed"); }
$("sidescrim").onclick = () => setSide(true);
$("sidecollapse").onclick = () => setSide(true);
$("sidetoggle").onclick = () => setSide(false);
setSide(ls.get("smol.side") === "1" || (narrow() && !!location.hash));

// ---- composer: slash commands, their arguments, @ files --------------------
// One menu above the input. Esc closes it (until the text changes); it never
// clears what was typed.
let menuIdx = 0, menuPicked = false, menuClosedFor = null, menuCache = null;
function cmdList() { return (active && active.state.commands) || []; }
// Values come with the command in the state; the server is asked for fresh
// ones (running tasks change) and the menu shows the inline ones meanwhile.
function loadArgs(v, name) {
  if (v.args && v.args.name === name && (v.args.loading || Date.now() - v.args.at < 5000)) return v.args;
  const cmd = cmdList().find((c) => c.name === name);
  const inline = cmd && Array.isArray(cmd.argOptions) ? cmd.argOptions : null;
  v.args = { name, at: Date.now(), loading: !inline, options: inline || [] };
  const mine = v.args;
  post("/command/args", { sid: v.sid, name }).then((r) => {
    mine.loading = false; mine.at = Date.now();
    if (r && Array.isArray(r.options) && (r.options.length || !inline)) mine.options = r.options;
    if (v === active) renderMenu();
  });
  return mine;
}
function loadFiles(v) {
  if (v.files && (v.files.loading || Date.now() - v.files.at < 15000)) return v.files;
  const mine = v.files = { at: Date.now(), loading: true, list: [] };
  fetch("/files?k=" + k + "&sid=" + encodeURIComponent(v.sid)).then((r) => r.json()).catch(() => ({})).then((r) => {
    mine.loading = false; mine.at = Date.now(); mine.list = (r && r.files) || []; mine.truncated = !!(r && r.truncated);
    if (v === active) renderMenu();
  });
  return mine;
}
// What the menu offers for the text as it stands: null when nothing.
function computeMenu() {
  const v = active;
  if (!v) return null;
  const val = input.value;
  if (menuClosedFor === val) return null;
  if (val.startsWith("/") && !val.includes("\n")) {
    const sp = val.indexOf(" ");
    if (sp < 0) {
      const q = val.slice(1);
      const cmds = rank(q, cmdList(), (c) => [c.name, (c.aliases || []).join(" "), c.desc]);
      const items = (q ? cmds : grouped(cmds)).map((c) => ({
        label: "/" + c.name, desc: c.desc, key: c.key, group: c.group, args: !!c.args,
        run: () => { if (c.args) { setInput("/" + c.name + " "); } else sendText("/" + c.name); },
        complete: () => setInput("/" + c.name + (c.args ? " " : "")),
      }));
      return items.length ? { kind: "slash", items, groups: !q } : null;
    }
    const name = val.slice(1, sp);
    const cmd = cmdList().find((c) => c.name === name);
    if (!cmd || !cmd.args) return null;
    const q = val.slice(sp + 1);
    if (q.includes(" ")) return null;
    const a = loadArgs(v, name);
    if (a.loading) return { kind: "args", items: [{ label: "loading…", inert: true }], none: true };
    const opts = rank(q, a.options, (o) => [o.label, o.keywords, o.hint]);
    if (!opts.length) return null;
    const items = (q ? opts : grouped(opts)).map((o) => ({
      label: o.label, desc: o.hint, group: o.group, current: o.current, starred: o.starred,
      run: () => sendText("/" + name + " " + o.label),
      complete: () => setInput("/" + name + " " + o.label),
    }));
    // No filter typed: nothing is picked, so Enter still runs the bare command.
    return { kind: "args", items, groups: !q, none: !q };
  }
  const caret = input.selectionStart === input.selectionEnd ? input.selectionStart : -1;
  if (caret < 0) return null;
  const mm = /(^|\s)@([^\s@]*)$/.exec(val.slice(0, caret));
  if (!mm) return null;
  const f = loadFiles(v);
  if (f.loading) return { kind: "files", items: [{ label: "listing files…", inert: true }], none: true };
  const q = mm[2];
  const hits = rank(q, f.list, (p) => [p.split("/").pop(), p]).slice(0, 50);
  if (!hits.length) return null;
  const start = caret - q.length - 1;
  const insert = (p) => {
    // Only the path goes into the message: never the file's contents.
    const after = input.value.slice(caret);
    setInput(input.value.slice(0, start) + p + (after.startsWith(" ") ? "" : " ") + after, start + p.length + 1);
  };
  return { kind: "files", items: hits.map((p) => ({ label: p, run: () => insert(p), complete: () => insert(p) })) };
}
function setInput(text, caret) {
  input.value = text;
  const c = caret === undefined ? text.length : caret;
  input.setSelectionRange(c, c);
  input.focus();
  onInputChanged();
}
function renderMenu() {
  const m = menuCache = computeMenu();
  menu.innerHTML = "";
  if (!m) { menu.style.display = "none"; placeToasts(); return; }
  menu.style.display = "block";
  setTimeout(placeToasts, 0);
  if (m.none && !menuPicked) menuIdx = -1;
  else if (menuIdx < 0 || menuIdx >= m.items.length) menuIdx = 0;
  let last = null;
  m.items.forEach((it, i) => {
    if (m.groups && it.group && it.group !== last) menu.appendChild(el("div", "mgroup", it.group));
    last = it.group;
    const d = el("div", "item" + (i === menuIdx ? " sel" : "") + (it.inert ? " inert" : ""));
    if (it.starred) d.appendChild(el("span", "star on", "★"));
    d.appendChild(el("span", "nm", (it.current ? "● " : "") + it.label));
    if (it.desc) d.appendChild(el("span", "ds", it.desc));
    if (it.key) d.appendChild(el("kbd", "mkey", it.key));
    if (!it.inert) { d.onmousedown = (e) => e.preventDefault(); d.onclick = () => it.run(); }
    menu.appendChild(d);
    if (i === menuIdx) setTimeout(() => d.scrollIntoView({ block: "nearest" }), 0);
  });
}
function menuMove(step) {
  const m = menuCache;
  if (!m) return;
  const n = m.items.length;
  menuIdx = menuIdx < 0 ? (step > 0 ? 0 : n - 1) : (menuIdx + step + n) % n;
  menuPicked = true;
  renderMenu();
}
// ---- prompt history (per workspace) and drafts (per session) -------------
function histKey(v) { return "smol.hist." + String((v && v.state.workspace) || "").replace(/\\/g, "/").toLowerCase(); }
function promptHistory(v) { try { const h = JSON.parse(ls.get(histKey(v)) || "[]"); return Array.isArray(h) ? h : []; } catch (e) { return []; } }
function remember(v, text) {
  if (!text.trim()) return;
  const h = promptHistory(v).filter((x) => x !== text);
  h.push(text);
  ls.set(histKey(v), JSON.stringify(h.slice(-100)));
}
let draftTimer = null;
function saveDraft(v) {
  if (!v) return;
  if (v.draft) ls.set(draftKey(v.sid), v.draft); else ls.del(draftKey(v.sid));
}
function onInputChanged() {
  menuIdx = 0; menuPicked = false;
  if (menuClosedFor !== input.value) menuClosedFor = null;
  renderMenu(); autoGrow();
  if (active) {
    active.draft = input.value;
    const v = active;
    clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(v), 250);
  }
}
function sendText(text) {
  input.value = text;
  submit(true);
}
function submit(direct) {
  if (!active) return;
  const v = active;
  let text = input.value;
  if (!direct && menuCache && menuIdx >= 0 && !menuCache.items[menuIdx].inert) { menuCache.items[menuIdx].run(); return; }
  text = text.trim();
  const pending = pendingOf(v);
  if (pending.some((a) => a.uploading)) { toast("Waiting for the upload to finish"); return; }
  const files = pending.filter((a) => a.id).map((a) => a.id);
  if (!text && !files.length) return;
  const info = sessInfo.get(v.sid);
  // Busy (or the queue is paused): the server queues it; show the chip right away.
  if (v.busyLabel || (info && info.live && info.status !== "idle") || (v.state.queuePaused && (v.state.queued || []).length)) {
    v.localQueue.push({ local: true, text, files: pending.filter((a) => a.id).map((a) => a.name) });
  }
  remember(v, text);
  v.histIdx = -1;
  input.value = ""; v.draft = ""; saveDraft(v); v.pending = []; menuClosedFor = null; renderMenu(); autoGrow(); renderAttachments(); renderQueue();
  scrollToBottom();
  post("/msg", { sid: v.sid, text, attachments: files }).then((r) => {
    if (r && r.error) { v.localQueue = []; if (v === active) renderQueue(); toastError(r.error); }
  });
}
// The textarea grows with its content, up to a cap, from its real height.
function autoGrow() {
  input.style.height = "auto";
  const max = Math.max(120, Math.round(window.innerHeight * 0.4));
  input.style.height = Math.min(input.scrollHeight, max) + "px";
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  input.dir = dirOf(input.value) || "auto";
}
const coarse = window.matchMedia("(pointer: coarse)");
input.addEventListener("input", () => { if (active) active.histIdx = -1; onInputChanged(); });
input.addEventListener("click", () => renderMenu());
input.addEventListener("keydown", (e) => {
  // While an IME is composing, Enter and Esc belong to it. Safari reports
  // the closing Enter only as keyCode 229.
  if (e.isComposing || e.keyCode === 229) return;
  const open = !!menuCache;
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
    // A phone's Return key adds a line; the send button sends.
    if (coarse.matches && !open) return;
    e.preventDefault(); submit(false);
  }
  else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (active) post("/cycle", { sid: active.sid }); }
  else if (e.key === "Tab" && open) {
    e.preventDefault();
    const it = menuCache.items[Math.max(0, menuIdx)];
    if (it && !it.inert) it.complete();
  }
  else if (e.key === "ArrowUp" && open) { e.preventDefault(); menuMove(-1); }
  else if (e.key === "ArrowDown" && open) { e.preventDefault(); menuMove(1); }
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && active && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    // History: only from an empty composer, or while stepping through it.
    const v = active, h = promptHistory(v);
    const stepping = v.histIdx >= 0 && input.value === h[v.histIdx];
    if (!(input.value === "" || stepping) || !h.length) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      const i = (v.histIdx < 0 ? h.length : v.histIdx) - 1;
      if (i < 0) return;
      v.histIdx = i; input.value = h[i];
    } else {
      if (v.histIdx < 0) return;
      const i = v.histIdx + 1;
      if (i >= h.length) { v.histIdx = -1; input.value = ""; } else { v.histIdx = i; input.value = h[i]; }
    }
    input.setSelectionRange(input.value.length, input.value.length);
    v.draft = input.value; autoGrow(); renderMenu();
  }
  else if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    if (open) { menuClosedFor = input.value; renderMenu(); }
    else if (sideOverlayOpen()) setSide(true);
    else if (active && isWorking(active)) post("/cancel", { sid: active.sid });
  }
});
function isWorking(v) {
  const info = sessInfo.get(v.sid);
  return !!v.busyLabel || !!(info && info.live && (info.status === "busy" || info.status === "waiting"));
}
actionBtn.onclick = () => { if (!active) return; if (active.busyLabel) post("/cancel", { sid: active.sid }); else submit(false); };

// ---- attachments ----------------------------------------------------------
// Paste a screenshot (ctrl+v or right-click → paste), drop files on the chat,
// or pick them with the paperclip. Each file is uploaded right away and shown
// as a chip; the ids go with the next message.
const attachRow = $("attachrow"), filePick = $("filepick"), mainEl = $("main");
function pendingOf(v) { if (!v.pending) v.pending = []; return v.pending; }
function renderAttachments() {
  attachRow.innerHTML = "";
  const list = active ? pendingOf(active) : [];
  attachRow.hidden = !list.length;
  for (const a of list) {
    const chip = el("span", "attach" + (a.uploading ? " uploading" : "") + (a.warning ? " warn" : ""));
    if (a.kind === "image" && a.url) { const img = el("img", "attach-thumb"); img.src = a.url + "&k=" + k; img.alt = ""; chip.appendChild(img); }
    chip.appendChild(el("span", "attach-name", a.name));
    chip.appendChild(el("span", "dim", a.uploading ? "uploading…" : fmtSize(a.size)));
    if (a.warning) { chip.title = a.warning; chip.appendChild(el("span", "note", "model can't see images")); }
    const x = el("button", "attach-x", "×"); x.type = "button"; x.title = "remove"; x.onclick = () => removeAttachment(a);
    chip.appendChild(x);
    attachRow.appendChild(chip);
  }
}
function addFiles(files) {
  if (!active) return;
  for (const f of files) upload(active, f);
  input.focus();
}
async function upload(v, file) {
  const type = file.type || "application/octet-stream";
  const name = file.name || (type.startsWith("image/") ? "pasted-image." + (type.split("/")[1] || "png").replace("jpeg", "jpg") : "pasted.txt");
  const entry = { id: null, name, size: file.size, kind: type.startsWith("image/") ? "image" : "text", uploading: true };
  pendingOf(v).push(entry); renderAttachments();
  try {
    const r = await fetch("/upload?k=" + k + "&sid=" + v.sid + "&name=" + encodeURIComponent(name), { method: "POST", headers: { "content-type": type }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || ("upload failed (" + r.status + ")"));
    Object.assign(entry, d, { uploading: false });
  } catch (err) {
    const list = pendingOf(v); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1);
    toastError(String((err && err.message) || err));
  }
  renderAttachments();
}
function removeAttachment(a) {
  if (!active) return;
  const list = pendingOf(active); const i = list.indexOf(a); if (i >= 0) list.splice(i, 1);
  if (a.id) post("/upload/remove", { sid: active.sid, id: a.id });
  renderAttachments();
}
$("attachbtn").onclick = () => { if (active) filePick.click(); };
filePick.onchange = () => { addFiles([...filePick.files]); filePick.value = ""; };
input.addEventListener("paste", (e) => {
  const files = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  addFiles(files);
});
function hasFiles(e) { return !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files")); }
mainEl.addEventListener("dragover", (e) => { if (!active || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; mainEl.classList.add("dragging"); });
mainEl.addEventListener("dragleave", (e) => { if (e.relatedTarget && mainEl.contains(e.relatedTarget)) return; mainEl.classList.remove("dragging"); });
mainEl.addEventListener("drop", (e) => { mainEl.classList.remove("dragging"); if (!active || !hasFiles(e)) return; e.preventDefault(); addFiles([...e.dataTransfer.files]); });

// ---- desktop notifications (opt-in, from the palette) ----------------------
let notifyOn = ls.get("smol.notify") === "1";
function notifySupported() { return typeof Notification !== "undefined"; }
function setNotify(on) {
  if (!on) { notifyOn = false; ls.set("smol.notify", "0"); toast("Desktop notifications off"); return; }
  if (!notifySupported()) { toastError("This browser cannot show desktop notifications"); return; }
  const apply = (p) => {
    if (p === "granted") { notifyOn = true; ls.set("smol.notify", "1"); toast("Desktop notifications on: you'll hear about finished turns and questions while away"); }
    else toastError("Notifications are blocked for this page; allow them in the browser's site settings");
  };
  if (Notification.permission === "granted") apply("granted");
  else Promise.resolve(Notification.requestPermission()).then(apply, () => apply("denied"));
}
// Only live events, and only when the user is not already looking at it.
function notify(v, title, body) {
  if (!notifyOn || replaying || replayEvent || !notifySupported() || Notification.permission !== "granted") return;
  if (!document.hidden && v === active && document.hasFocus()) return;
  const info = sessInfo.get(v.sid);
  const name = (info && (info.title || info.wsname)) || "smol";
  try {
    const n = new Notification(title + " · " + name, { body: String(body || "").slice(0, 200), tag: "smol-" + v.sid });
    n.onclick = () => { window.focus(); if (active !== v) select(v.sid); n.close(); };
  } catch (e) { /* some browsers only allow notifications from a service worker */ }
}

// ---- updates: a pill next to the version, a popover with the details --------
// The hub checks the registry (at most every 12 hours) and runs the package
// manager; the page only shows it. "Restart server" brings a new hub up on
// the same port with the same key: the stream reconnects by itself and the
// replay lands back on the open session.
let upd = null;            // the hub's update state (hub snapshot .update)
let updPop = null;         // the open popover
let updRestart = null;     // { from, at } while the server restarts
const updPill = $("updpill");
const ICON_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_EXT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
function updBusy(u) { return !!u && (u.phase === "running" || u.phase === "checking" || u.phase === "restarting"); }
function renderUpdate(u) {
  upd = u || null;
  // Shown when a newer version is out (and notices are on), and whenever
  // the updater has something to say.
  const show = !!upd && ((upd.newer && upd.enabled) || (upd.phase !== "idle" && upd.phase !== "checking") || (upd.newer && !!updPop));
  updPill.hidden = !show;
  if (show) {
    const done = upd.phase === "done" || upd.phase === "restarting";
    updPill.classList.toggle("done", done);
    updPill.querySelector(".sb-updlabel").textContent = done ? "Restart to update" : upd.phase === "running" ? "Updating" : upd.phase === "failed" ? "Update failed" : "Update available";
    updPill.querySelector(".sb-updver").textContent = upd.installed || upd.latest || "";
    const what = done ? "Restart to use " + (upd.installed || upd.latest) : "Update available: " + upd.latest;
    updPill.title = what; updPill.setAttribute("aria-label", what);
  }
  if (updPop) drawUpdPop();
}
function closeUpdPop() {
  if (!updPop) return;
  updPop.root.remove(); document.removeEventListener("mousedown", updPop.outside, true);
  updPop = null; renderUpdate(upd); placeToasts();
}
function openUpdPop(check) {
  if (updPop) { drawUpdPop(); return; }
  closePicker(null);
  const root = el("div", "upd-pop"); root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Update smolcoder"); root.tabIndex = -1;
  const outside = (e) => { if (!root.contains(e.target) && !updPill.contains(e.target) && !$("ver").contains(e.target)) closeUpdPop(); };
  document.addEventListener("mousedown", outside, true);
  document.body.appendChild(root);
  updPop = { root, outside };
  if (check && !updBusy(upd)) { if (upd) upd = Object.assign({}, upd, { phase: "checking" }); post("/update/check"); }
  renderUpdate(upd);
  placeUpdPop();
  const first = root.querySelector("button.primary") || root.querySelector("button");
  (first || root).focus({ preventScroll: true });
}
function placeUpdPop() {
  if (!updPop) return;
  const a = (!updPill.hidden ? updPill : $("ver")).getBoundingClientRect();
  const r = updPop.root;
  const w = Math.min(340, window.innerWidth - 16);
  r.style.width = w + "px";
  r.style.left = Math.max(8, Math.min(a.left - 8, window.innerWidth - w - 8)) + "px";
  r.style.bottom = Math.max(8, window.innerHeight - a.top + 8) + "px";
}
window.addEventListener("resize", placeUpdPop);
function updCode(text) {
  const row = el("div", "upd-code");
  row.appendChild(el("code", "", text));
  const b = el("button", "upd-copy", "Copy"); b.type = "button"; b.title = "Copy the command";
  b.onclick = () => copyText(text, "Command");
  row.appendChild(b);
  return row;
}
function drawUpdPop() {
  const r = updPop.root, u = upd || { phase: "checking", current: hub.version };
  const focused = document.activeElement && r.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  r.innerHTML = "";
  const newer = !!u.newer && !!u.latest;
  const title = u.phase === "restarting" ? "Restarting…" : u.phase === "done" ? "Update installed" : u.phase === "running" ? "Updating smolcoder" : u.phase === "failed" ? "Update failed" : u.phase === "checking" && !newer ? "Checking for updates…" : newer ? "Update available" : u.latest ? "smolcoder is up to date" : "Updates";
  const hdr = el("div", "upd-hdr");
  hdr.appendChild(el("span", "upd-title", title));
  const x = el("button", "iconbtn upd-x", "×"); x.type = "button"; x.title = "Close"; x.setAttribute("aria-label", "Close"); x.onclick = closeUpdPop;
  hdr.appendChild(x);
  r.appendChild(hdr);
  // current → latest
  const vers = el("div", "upd-vers");
  vers.appendChild(el("span", "upd-cur", "v" + (u.current || hub.version)));
  if (newer || u.installed) {
    vers.appendChild(el("span", "upd-arrow", "→"));
    vers.appendChild(el("span", "upd-new", "v" + (u.installed || u.latest)));
  } else if (u.latest) vers.appendChild(el("span", "upd-note", "latest"));
  r.appendChild(vers);
  if (newer || u.installed) {
    const a = el("a", "upd-link"); a.href = u.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.appendChild(el("span", "", "What's new in " + (u.installed || u.latest)));
    a.insertAdjacentHTML("beforeend", ICON_EXT);
    r.appendChild(a);
  }
  if (u.install && (u.phase === "running" || u.phase === "done" || u.phase === "failed")) {
    // The output's first line is the command: only say how it is installed.
    r.appendChild(el("div", "upd-meta", u.install.label + (u.install.command && !u.log ? " · " + u.install.command : "")));
  }
  if (u.log && (u.phase === "running" || u.phase === "failed" || u.phase === "done")) {
    const pre = el("pre", "upd-log", u.log.replace(/\s+$/, ""));
    r.appendChild(pre);
    pre.scrollTop = pre.scrollHeight;
  }
  const msg = (text, kind) => {
    if (!text) return;
    const lines = String(text).split("\n");
    const box = el("div", "upd-msg" + (kind ? " " + kind : ""));
    box.appendChild(el("div", "upd-msgline", lines[0]));
    for (const l of lines.slice(1)) {
      if (/^\s{2}\S/.test(l)) box.appendChild(updCode(l.trim()));
      else if (l.trim()) box.appendChild(el("div", "upd-msgsub", l.trim()));
    }
    r.appendChild(box);
  };
  const acts = el("div", "upd-acts");
  const btn = (label, cls, act, run) => { const b = el("button", cls, label); b.type = "button"; b.dataset.act = act; b.onclick = run; acts.appendChild(b); return b; };
  const spin = (label) => { const s = el("div", "upd-busy"); s.appendChild(el("span", "upd-spin")); s.appendChild(el("span", "", label)); acts.appendChild(s); };
  switch (u.phase) {
    case "checking": spin("Asking the npm registry…"); break;
    case "running": spin("Installing " + u.latest + "…"); break;
    case "restarting":
      spin(updRestart && Date.now() - updRestart.at > 30000 ? "Still waiting. Check the terminal running smol --web" : "The page reconnects by itself");
      break;
    case "done":
      msg("Restart the server to use it. Open sessions are saved and reopen where they were.", "ok");
      if (u.canRestart) btn("Restart server", "primary", "restart", () => { updRestart = { from: hub.version, at: Date.now() }; upd = Object.assign({}, upd, { phase: "restarting" }); drawUpdPop(); post("/update/restart").then((res) => { if (res && res.error) { updRestart = null; toastError(res.error); } }); });
      btn("Later", "ghost", "later", closeUpdPop);
      break;
    case "manual":
      msg(((u.install && u.install.reason) || "This copy cannot update itself") + "\n  " + ((u.install && u.install.manualCommand) || "npm install -g smolcoder@latest"));
      btn("Close", "ghost", "close", closeUpdPop);
      break;
    case "failed":
      msg(u.message, "err");
      btn("Try again", "primary", "update", () => post("/update/run"));
      btn("Close", "ghost", "close", closeUpdPop);
      break;
    default:
      if (u.message) msg(u.message, "err");
      if (newer) { btn("Update", "primary", "update", () => post("/update/run")); btn("Not now", "ghost", "later", closeUpdPop); }
      else btn("Check again", "ghost", "check", () => { upd = Object.assign({}, upd, { phase: "checking" }); drawUpdPop(); post("/update/check"); });
  }
  if (acts.children.length) r.appendChild(acts);
  // The opt-out, where people look for it.
  const opt = el("label", "upd-opt");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = !(u && u.enabled === false); cb.dataset.act = "notices";
  cb.onchange = () => post("/update/notices", { on: cb.checked }).then(() => toast(cb.checked ? "Update notices on" : "Update notices off: the palette's Check for updates still works"));
  opt.appendChild(cb); opt.appendChild(el("span", "", "Tell me when a new version is out"));
  r.appendChild(opt);
  if (focused) { const f = r.querySelector('[data-act="' + focused + '"]'); if (f) f.focus({ preventScroll: true }); }
  placeUpdPop();
}
updPill.onclick = () => { if (updPop) closeUpdPop(); else openUpdPop(false); };
// After a restart: the new server's first snapshot says how it went.
function updAfterSnapshot() {
  if (!updRestart || !upd || upd.phase === "restarting") return;
  const from = updRestart.from;
  updRestart = null;
  closeUpdPop();
  toast(hub.version !== from ? "Updated to v" + hub.version + ". Sessions reopened where they were" : "Server restarted", { kind: "success", ms: 6000 });
}

// ---- command palette (ctrl+k) ------------------------------------------------
let palette = null;
function paletteItems() {
  const items = [];
  const v = active;
  if (v) {
    // The updater has its own actions below (they work without a session).
    for (const c of cmdList()) {
      if (c.name === "update" || c.name === "update-check") continue;
      items.push({
        group: c.group || "Commands", label: "/" + c.name, hint: c.desc, key: c.key, keywords: (c.aliases || []).join(" "),
        run: () => { if (c.args) setInput("/" + c.name + " "); else post("/msg", { sid: v.sid, text: "/" + c.name }); },
      });
    }
  }
  for (const w of hub.workspaces) {
    for (const s of w.sessions) {
      items.push({
        group: "Sessions", label: s.title || "new session", hint: w.name + " · " + (s.live ? s.status : "saved") + " · " + rel(s.updatedAt),
        keywords: w.path + " " + (s.model || ""), current: !!(v && v.sid === s.id), run: () => select(s.id),
      });
    }
  }
  // The project, as Alt+N does: never a worktree session's own folder.
  const ws = curProject();
  if (ws) items.push({ group: "Actions", label: "New session", hint: shortPath(ws), key: ALT.toLowerCase() + "+n", run: () => newSession(ws) });
  items.push({ group: "Actions", label: "Add project…", hint: "type a path, or pick a recent folder", keywords: "open folder workspace", run: () => openAddProject() });
  items.push({ group: "Actions", label: "Open folder…", hint: "browse in a dialog", run: () => openDialog() });
  items.push({ group: "Actions", label: "Search sessions", hint: "titles, then transcripts", keywords: "find", run: () => { setSide(false); sbSearch.focus(); sbSearch.select(); } });
  const here = curProject(), hw = here && hub.workspaces.find((w) => w.path === here);
  if (hw) items.push({ group: "Actions", label: "New session on a branch…", hint: hw.name + " · git worktree", keywords: "worktree", run: () => { const r = sbNewBtn.getBoundingClientRect(); branchPrompt(hw, { x: r.left, y: r.bottom + 4 }); } });
  items.push({ group: "Actions", label: "Desktop notifications: " + (notifyOn ? "on" : "off"), hint: notifyOn ? "turn off" : "tell me when a turn ends or needs me", keywords: "notify alerts toggle", run: () => setNotify(!notifyOn) });
  const newer = upd && upd.newer && upd.latest;
  items.push({ group: "Actions", label: newer ? "Update smolcoder to " + upd.latest : "Check for updates", hint: "smolcoder v" + hub.version, keywords: "update upgrade version release new", run: () => openUpdPop(true) });
  const notices = !(upd && upd.enabled === false);
  items.push({ group: "Actions", label: "Update notices: " + (notices ? "on" : "off"), hint: notices ? "turn off" : "tell me when a new version is out", keywords: "update upgrade check toggle", run: () => post("/update/notices", { on: !notices }).then(() => toast(notices ? "Update notices off" : "Update notices on")) });
  items.push({ group: "Actions", label: "Toggle sidebar", key: "ctrl+b", run: () => setSide(!sideEl.classList.contains("collapsed")) });
  if (v) {
    items.push({ group: "Actions", label: "Toggle terminal", key: "ctrl+\`", run: () => togglePanelKind("term") });
    items.push({ group: "Actions", label: "Toggle browser preview", run: () => togglePanelKind("browser") });
    items.push({ group: "Actions", label: "Scroll to latest", run: scrollToBottom });
    if (isWorking(v)) items.push({ group: "Actions", label: "Stop the agent", key: "esc", run: () => post("/cancel", { sid: v.sid }) });
  }
  items.push({ group: "Actions", label: "Keyboard shortcuts", key: "?", run: showKeys });
  return items;
}
function openPalette() {
  if (palette) { palette.ch.field.focus(); return; }
  closePicker(null);
  const back = el("div", "palette-backdrop");
  const ch = chooser({
    cls: "palette", items: paletteItems(), placeholder: "Search commands, sessions and actions…",
    foot: "↑↓ move · enter run · esc close",
    onChoose: (it) => it.run(),
    onClose: () => { back.remove(); palette = null; if (active) input.focus({ preventScroll: true }); },
  });
  back.appendChild(ch.root);
  document.body.appendChild(back);
  palette = { ch, back };
  ch.field.focus();
}

// ---- global keys ----------------------------------------------------------
function showKeys() {
  const dialog = document.createElement("dialog"); dialog.className = "dlg";
  const list = el("div", "shortcut-list");
  ["/  Commands", "@  Mention a file (inserts its path)", "Ctrl+K  Command palette", "Enter  Send", "Shift+Enter  New line",
   "↑ / ↓  Earlier prompts (empty composer)", "Ctrl+V  Paste an image or a file", "Shift+Tab  Permission mode",
   "Esc  Close a menu, or stop the agent", "Ctrl+B  Sidebar", "Ctrl+\`  Terminal",
   ALT + "+N  New session in this project", ALT + "+↑ / " + ALT + "+↓  Previous / next session", ALT + "+1…9  Jump to a session (hold " + ALT + " for numbers)",
   "F2  Rename the session", "Right-click  Session or project menu", "Ctrl+Z  Undo archive or delete"].forEach((s) => list.appendChild(el("div", "", s)));
  const close = el("button", "ghost", "Close"); close.onclick = () => dialog.close(); list.appendChild(close);
  dialog.appendChild(list); document.body.appendChild(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal();
}
$("keys").onclick = showKeys;
document.addEventListener("keydown", (e) => {
  if (sidebarKey(e)) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); if (palette) palette.ch.cancel(); else openPalette(); return; }
  if (e.key === "Escape" && updPop) { e.preventDefault(); closeUpdPop(); return; }
  if (e.key === "Escape" && document.activeElement !== input) {
    if (sbMenu) closeMenu();
    else if (addProj) addProj.close();
    else if (palette) palette.ch.cancel();
    else if (picker) closePicker(null);
    else if (!$("modal").hidden) closeDialog();
    else if (sideOverlayOpen()) { e.preventDefault(); setSide(true); if (active) input.focus({ preventScroll: true }); }
    else if (active && isWorking(active) && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".tabbody.term"))) post("/cancel", { sid: active.sid });
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); setSide(!sideEl.classList.contains("collapsed")); }
  else if (e.ctrlKey && e.key === "\`") { e.preventDefault(); togglePanelKind("term"); }
});

// ---- connect --------------------------------------------------------------
// The server numbers its events. On a reconnect the browser sends the last
// id it saw and gets only what it missed, so the transcript, open
// disclosures and scroll positions stay as they are. Only a "reset" (first
// visit, or a gap too long to fill) clears the views for a full replay.
let replaying = true;
function resetView(v) {
  v.logEl.innerHTML = ""; v.logEl.classList.add("fresh"); v.curText = null; v.curThought = null; v.curTool = null; v.planEl = null; v.argsRow = null; v.asks.clear();
}
function resetViews() {
  replaying = true;
  closePicker(null);
  for (const v of views.values()) {
    resetView(v);
    for (const t of v.terms.values()) { t.out.innerHTML = ""; t.cur = null; t.lines = 0; }
  }
}
// The browser reconnects by itself; should it give up (a server that was
// gone for a while), start a new stream.
let es = null;
function connect() {
  es = new EventSource("/events?k=" + k);
  es.onmessage = (e) => handle(JSON.parse(e.data));
  es.onerror = () => {
    $("status").textContent = "reconnecting…";
    if (es.readyState === 2) setTimeout(connect, 1500);
    if (updRestart && updPop) drawUpdPop();
  };
}
connect();
`;

// The browser-side script for the web page. Plain JS in a raw template string
// (no build step, no dependencies). Rules: no template literals in here, and
// a literal backtick is written as \` — String.raw hands it through as-is.
//
// Layout: a workspace sidebar on the left, the active session's transcript in
// the middle, and an optional right panel with browser and terminal tabs.
// Every session keeps its own view (transcript DOM, status, draft input,
// panel tabs) so switching is instant and background sessions keep streaming.

export const CLIENT_JS = String.raw`
"use strict";
const k = new URLSearchParams(location.search).get("k") || "";
const $ = (id) => document.getElementById(id);
const ls = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch (e) {} },
};
const logwrap = $("logwrap"), logsEl = $("logs"), busyEl = $("busy"), actionBtn = $("actionbtn");
const input = $("input"), menu = $("menu"), sideEl = $("side"), panelEl = $("panel"), tabsEl = $("paneltabs");

let hub = { workspaces: [], home: "", version: "" };
const sessInfo = new Map();   // sid -> sidebar entry from the last hub snapshot
const views = new Map();      // sid -> per-session view state
let active = null;
let pendingSelect = null;
let busyTimer = null;
let stickBottom = true;
let uidCounter = 0;
const uid = () => "u" + (++uidCounter) + "_" + Date.now().toString(36);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function post(path, body) {
  return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({}));
}
function rel(ts) {
  const d = Date.now() - (ts || 0);
  if (!ts || d < 60e3) return "now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
  return new Date(ts).toLocaleDateString();
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
function renderMarkdown(src) {
  const lines = esc(src).split("\n");
  let out = "", i = 0, listType = null;
  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*\`\`\`(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body = []; i++;
      while (i < lines.length && !/^\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out += "<pre><code>" + body.join("\n") + "</code></pre>";
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += "<table><thead><tr>" + head.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
      for (const r of rows) out += "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>";
      out += "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out += "<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }
    // NB: lines are already escaped, so the blockquote marker is "&gt;".
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out += "<blockquote>" + inlineMd(body.join(" ")) + "</blockquote>";
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out += "<" + want + ">"; listType = want; }
      out += "<li>" + inlineMd((ul || ol)[1]) + "</li>";
      i++; continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
           !/^(\s*#{1,6}\s|\s*\`\`\`|\s*>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    out += "<p>" + inlineMd(para.join(" ")) + "</p>";
  }
  closeList();
  return out;
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
function getView(sid) {
  let v = views.get(sid);
  if (!v) {
    v = {
      sid, logEl: el("div", "log"), state: { commands: [] }, curText: null, curThought: null, thoughtBuf: "", thoughtStart: 0,
      busyLabel: null, busyStart: 0, unread: false, draft: "", scrollTop: null, asks: new Map(),
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
  v.logEl.remove(); v.panelEl.remove();
  views.delete(sid);
  if (active === v) show(null);
}
function stick() { if (stickBottom) logwrap.scrollTop = logwrap.scrollHeight; }
logwrap.addEventListener("scroll", () => { stickBottom = logwrap.scrollHeight - logwrap.scrollTop - logwrap.clientHeight < 120; });
function add(v, e) { v.logEl.appendChild(e); if (v === active) stick(); return e; }
// Streaming: accumulate raw markdown on the element, re-render on a short
// timer. NOT requestAnimationFrame: rAF never fires in background tabs, so a
// response streamed while the tab is hidden would never render.
function scheduleMd(v, target) {
  if (target._pending) return;
  target._pending = true;
  setTimeout(() => { target._pending = false; target.innerHTML = renderMarkdown(target._raw || ""); if (v === active) stick(); }, 60);
}
function endThought(v) {
  if (v.curThought) {
    v.curThought.textContent = "✦ thought for " + ((Date.now() - v.thoughtStart) / 1000).toFixed(1) + "s";
    v.curThought = null; v.thoughtBuf = "";
  }
}

function setBusy(v, label) {
  v.busyLabel = label || null;
  if (label) v.busyStart = Date.now();
  if (v === active) renderBusy();
}
function renderBusy() {
  const label = active ? active.busyLabel : null;
  actionBtn.textContent = label ? "■ stop" : "send";
  actionBtn.className = label ? "stop" : "";
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

function renderState(v) {
  for (const t of v.tabs) if (t.kind === "browser") fillUrls(t, v.state.urls || []);
  if (v !== active) return;
  const s = v.state;
  const st = $("status");
  st.innerHTML = "";
  if (!s.mode) { st.textContent = "starting…"; renderCrumb(); return; }
  const mode = el("span", "mode " + s.mode, s.mode === "ro" ? "read-only" : s.mode === "bypass" ? "bypass permissions" : s.mode);
  st.appendChild(mode);
  st.appendChild(document.createTextNode(" · " + s.model + " (" + s.backend + ")"));
  if (s.effort) { st.appendChild(document.createTextNode(" · ")); st.appendChild(el("span", "eff", s.effort)); }
  const kt = s.ctxTokens < 1000 ? s.ctxTokens : (s.ctxTokens / 1000).toFixed(1) + "k";
  st.appendChild(document.createTextNode(" · " + kt + " (" + s.ctxPct + "%)"));
  if (s.plan) {
    st.appendChild(document.createTextNode(" · "));
    const done = s.plan.steps.filter((x) => x.done).length;
    st.appendChild(el("span", "plan-chip" + (s.plan.current < 0 ? " done" : ""), "plan " + done + "/" + s.plan.steps.length));
  }
  if (s.tasks) st.appendChild(document.createTextNode(" · " + s.tasks + " task" + (s.tasks > 1 ? "s" : "")));
  $("ws").textContent = shortPath(s.workspace || "");
  renderCrumb();
}

function renderPlan(v, p) {
  const box = el("div", "plan");
  const done = p.steps.filter((x) => x.done).length;
  const hdr = el("div", "hdr", "Plan ");
  hdr.appendChild(el("small", "", done + "/" + p.steps.length));
  box.appendChild(hdr);
  p.steps.forEach((s, i) => {
    const cls = s.done ? "done" : i === p.current ? "cur" : "todo";
    const mark = s.done ? "✔ " : i === p.current ? "▶ " : "○ ";
    box.appendChild(el("div", cls, mark + s.text));
  });
  add(v, box);
}

// ---- event handling -------------------------------------------------------
function handle(m) {
  if (m.t === "hub") { onHub(m); return; }
  if (m.t === "closed") { dropView(m.sid); return; }
  if (!m.sid) return;
  const v = getView(m.sid);
  switch (m.t) {
    case "state":
      v.state = Object.assign(v.state, m.s);
      if (m.s && "busy" in m.s) setBusy(v, m.s.busy);
      renderState(v); break;
    case "user": endThought(v); v.curText = null; add(v, el("div", "user", m.s)); break;
    case "token":
      endThought(v);
      if (!v.curText) { v.curText = add(v, el("div", "md")); v.curText._raw = ""; }
      v.curText._raw += m.s; scheduleMd(v, v.curText); break;
    case "thinking":
      if (!v.curThought) { v.curThought = add(v, el("div", "thought")); v.thoughtStart = Date.now(); v.thoughtBuf = ""; v.curText = null; }
      v.thoughtBuf += m.s;
      if (v.thoughtBuf.length > 4000) v.thoughtBuf = v.thoughtBuf.slice(-2000);
      var tt = v.thoughtBuf.replace(/\s+/g, " ").trim();
      v.curThought.textContent = "✦ " + (tt.length > 160 ? "…" + tt.slice(-160) : tt);
      if (v === active) stick(); break;
    case "tool": {
      endThought(v); v.curText = null;
      const d = el("div", "tool"); d.appendChild(el("span", "name", "→ " + m.name)); d.appendChild(document.createTextNode(" " + (m.summary || "")));
      add(v, d); break;
    }
    case "result": endThought(v); v.curText = null; add(v, el("div", "result" + (m.err ? " err" : ""), (m.err ? "✗ " : "✓ ") + m.line + (m.extra ? " (+" + m.extra + " lines)" : ""))); break;
    case "plan": endThought(v); v.curText = null; renderPlan(v, m); break;
    case "line": endThought(v); v.curText = null; add(v, el("div", "line-" + m.kind, m.s)); break;
    case "turnend":
      endThought(v); v.curText = null; add(v, el("div", "turnend", "■ " + m.label));
      if (v !== active) { v.unread = true; renderSidebar(); }
      break;
    case "busy": setBusy(v, m.label); break;
    case "confirm": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "", "run?")); box.appendChild(el("div", "cmd", m.command));
      if (m.reason) box.appendChild(el("div", "hint", m.reason));
      ["yes", "no", "always"].forEach((a) => {
        const b = el("button", "", a === "always" ? "always allow this program" : a);
        b.onclick = () => { post("/confirm", { sid: v.sid, id: m.id, answer: a }); box.remove(); };
        box.appendChild(b);
      });
      v.asks.set(m.id, box);
      add(v, box); break;
    }
    case "answered": {
      // The server settled this prompt (answered here, elsewhere, or cancelled).
      const box = v.asks.get(m.id);
      if (box) { box.remove(); v.asks.delete(m.id); }
      break;
    }
    case "select": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      m.options.forEach((o, i) => {
        const b = el("button", "opt" + (o.current ? " current" : ""), (o.current ? "● " : "") + o.label);
        if (o.hint) b.appendChild(el("span", "hint", o.hint));
        b.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: i }); box.remove(); };
        box.appendChild(el("div")).appendChild(b);
      });
      const cancel = el("button", "", "cancel");
      cancel.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: null }); box.remove(); };
      box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box); break;
    }
    case "termopen": ensureTermTab(v, m.tid, m.cwd); break;
    case "term": termWrite(v, m.tid, m.s); break;
    case "termdone": termDone(v, m.tid, m.code, m.cwd); break;
    case "termclosed": removeTermTab(v, m.tid); break;
  }
}

// ---- hub snapshot + sidebar ------------------------------------------------
function onHub(m) {
  hub = m;
  sessInfo.clear();
  for (const w of m.workspaces) for (const s of w.sessions) sessInfo.set(s.id, Object.assign({ workspace: w.path, wsname: w.name }, s));
  for (const v of views.values()) reconcileTerms(v);
  $("ver").textContent = "v" + m.version;
  if (pendingSelect && sessInfo.has(pendingSelect)) { const id = pendingSelect; pendingSelect = null; show(id); }
  else if (!active) {
    const h = location.hash.slice(1);
    if (h && sessInfo.has(h)) select(h);
    else {
      const live = [...sessInfo.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      show(live ? live.id : null);
    }
  } else if (!sessInfo.has(active.sid) && !pendingSelect) show(null);
  renderSidebar(); renderCrumb(); renderTitle(); renderWelcome();
}
function select(id) {
  const s = sessInfo.get(id);
  if (s && (!s.live || s.status === "error")) post("/sessions/resume", { id });
  show(id);
}
function show(sid) {
  if (active) {
    active.draft = input.value; active.scrollTop = logwrap.scrollTop;
    active.logEl.hidden = true;
  }
  active = sid ? getView(sid) : null;
  $("welcome").hidden = !!active;
  $("bottom").hidden = !active;
  busyEl.hidden = !active;
  if (active) {
    active.logEl.hidden = false; active.unread = false;
    input.value = active.draft || ""; autoGrow(); menuIdx = 0; renderMenu();
    renderState(active); renderBusy();
    stickBottom = true;
    logwrap.scrollTop = active.scrollTop == null ? logwrap.scrollHeight : active.scrollTop;
    if (location.hash !== "#" + sid) history.replaceState(null, "", "#" + sid);
    // On a narrow window the sidebar floats over the chat: tuck it away once
    // a session is picked.
    if (narrow()) setSide(true);
    input.focus();
  } else {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    $("status").textContent = "";
  }
  renderPanel(); renderSidebar(); renderCrumb(); renderTitle(); renderWelcome();
}
function newSession(path) {
  post("/sessions/new", { workspace: path }).then((r) => { if (r.id) { pendingSelect = r.id; show(r.id); } else if (r.error) alert(r.error); });
}
function renderSidebar() {
  const list = $("wslist");
  list.innerHTML = "";
  if (!hub.workspaces.length) { list.appendChild(el("div", "sidehint", "No workspaces yet. Open a folder to start your first session.")); return; }
  for (const w of hub.workspaces) {
    const box = el("div", "ws");
    const hdr = el("div", "wshdr"); hdr.title = w.path;
    hdr.appendChild(el("span", "wsname", w.name)); hdr.appendChild(el("span", "wspath", w.display));
    const plus = el("button", "iconbtn", "+"); plus.title = "new session in " + w.name;
    plus.onclick = (e) => { e.stopPropagation(); newSession(w.path); };
    const rm = el("button", "iconbtn", "×"); rm.title = "remove " + w.name + " from the list";
    rm.onclick = (e) => { e.stopPropagation(); removeWorkspace(w); };
    hdr.appendChild(plus); hdr.appendChild(rm);
    if (!w.sessions.length) { hdr.style.cursor = "pointer"; hdr.onclick = () => newSession(w.path); }
    box.appendChild(hdr);
    const sl = el("div", "sessions");
    for (const s of w.sessions) {
      const v = views.get(s.id);
      const row = el("div", "sess " + (s.live ? s.status : "stored") + (active && active.sid === s.id ? " active" : "") + (v && v.unread ? " unread" : ""));
      row.appendChild(el("span", "dot"));
      row.appendChild(el("span", "stitle" + (s.title ? "" : " untitled"), s.title || "new session"));
      row.appendChild(el("span", "stime", rel(s.updatedAt)));
      const x = el("button", "iconbtn", "×");
      x.title = s.live ? "close session (kept in the list)" : "delete session";
      x.onclick = (e) => {
        e.stopPropagation();
        if (s.live) post("/sessions/close", { id: s.id });
        else if (confirm("Delete this session permanently?")) post("/sessions/delete", { id: s.id });
      };
      row.appendChild(x);
      row.title = (s.title || "new session") + (s.model ? " · " + s.model : "") + (s.live ? " · " + s.status : " · saved — click to resume");
      row.onclick = () => select(s.id);
      row.ondblclick = () => { const t = prompt("Rename session", s.title || ""); if (t !== null && t.trim()) post("/sessions/rename", { id: s.id, title: t }); };
      sl.appendChild(row);
    }
    box.appendChild(sl);
    list.appendChild(box);
  }
}
function removeWorkspace(w) {
  if (w.sessions.some((s) => s.live)) { alert("Close the open sessions in " + w.name + " first."); return; }
  const n = w.sessions.length;
  if (!confirm("Remove " + w.name + " from the list?" + (n ? " Its " + n + " saved session" + (n > 1 ? "s" : "") + " will be deleted." : ""))) return;
  post("/workspaces/remove", { path: w.path }).then((r) => { if (r.error) alert(r.error); });
}
function renderCrumb() {
  const c = $("crumb");
  c.innerHTML = "";
  if (!active) { c.appendChild(el("span", "ws", "smolcoder")); c.title = ""; return; }
  const info = sessInfo.get(active.sid);
  c.appendChild(el("span", "ws", info ? info.wsname : ""));
  c.appendChild(el("span", "sep", "›"));
  c.appendChild(el("span", "title", active.state.title || (info && info.title) || "new session"));
  if (active.state.model) c.appendChild(el("span", "model", active.state.model));
  c.title = info ? info.workspace : "";
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
  const r = $("recent");
  r.innerHTML = "";
  const ws = hub.workspaces.slice(0, 8);
  if (!ws.length) return;
  r.appendChild(el("div", "hint", "Start a session in a recent workspace:"));
  for (const x of ws) {
    const b = el("button", "wsbtn");
    b.appendChild(el("span", "", x.name)); b.appendChild(el("span", "dim", "  " + x.display));
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
    if (r.error) { alert(r.error); return; }
    closeDialog();
    if (r.id) { pendingSelect = r.id; show(r.id); }
  });
}
$("openfolder").onclick = () => openDialog();
$("welcomeopen").onclick = () => openDialog();
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
  empty.appendChild(el("div", "hint", "Sites that refuse to be embedded still open with ↗."));
  const urlsEl = el("div", "urls"); empty.appendChild(urlsEl);
  const frame = document.createElement("iframe"); frame.hidden = true;
  frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
  body.appendChild(bar); body.appendChild(empty); body.appendChild(frame);
  v.panelEl.appendChild(body);
  t.el = body; t.frame = frame; t.urlIn = urlIn; t.dl = dl; t.urlsEl = urlsEl;
  t.nav = (u) => {
    u = (u || "").trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
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
  inp.placeholder = "command… enter runs · ctrl+c interrupts · ctrl+l clears"; inp.spellcheck = false; inp.autocomplete = "off";
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
    if (!r.tid) { if (r.error) alert(r.error); return; }
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
  ls.set("smol.side", collapsed ? "1" : "0");
}
function narrow() { return window.matchMedia("(max-width: 1000px)").matches; }
$("sidecollapse").onclick = () => setSide(true);
$("sidetoggle").onclick = () => setSide(false);
setSide(ls.get("smol.side") === "1" || (narrow() && !!location.hash));

// ---- input + slash menu ---------------------------------------------------
let menuIdx = 0;
function menuItems() {
  const v = input.value;
  if (!active || !v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
  return (active.state.commands || []).filter((c) => c.name.startsWith(v.slice(1)));
}
function renderMenu() {
  const items = menuItems();
  menu.style.display = items.length ? "block" : "none";
  menu.innerHTML = "";
  if (menuIdx >= items.length) menuIdx = 0;
  items.forEach((c, i) => {
    const d = el("div", "item" + (i === menuIdx ? " sel" : ""));
    d.appendChild(el("span", "nm", "/" + c.name)); d.appendChild(el("span", "ds", c.desc));
    d.onclick = () => { input.value = "/" + c.name; submit(); };
    menu.appendChild(d);
  });
}
function submit() {
  if (!active) return;
  let v = input.value;
  const items = menuItems();
  if (items.length) v = "/" + items[menuIdx].name;
  v = v.trim();
  if (!v) return;
  input.value = ""; active.draft = ""; renderMenu(); autoGrow();
  stickBottom = true;
  post("/msg", { sid: active.sid, text: v });
}
function autoGrow() { input.rows = Math.min(6, Math.max(1, input.value.split("\n").length)); }
input.addEventListener("input", () => { menuIdx = 0; renderMenu(); autoGrow(); });
input.addEventListener("keydown", (e) => {
  const items = menuItems();
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (active) post("/cycle", { sid: active.sid }); }
  else if (e.key === "Tab" && items.length) { e.preventDefault(); input.value = "/" + items[menuIdx].name + " "; renderMenu(); }
  else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); menuIdx = (menuIdx - 1 + items.length) % items.length; renderMenu(); }
  else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); menuIdx = (menuIdx + 1) % items.length; renderMenu(); }
  else if (e.key === "Escape") { if (input.value) { input.value = ""; renderMenu(); autoGrow(); } else if (active) post("/cancel", { sid: active.sid }); }
});
actionBtn.onclick = () => { if (!active) return; if (active.busyLabel) post("/cancel", { sid: active.sid }); else submit(); };

// ---- global keys ----------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== input) {
    if (!$("modal").hidden) closeDialog();
    else if (active && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".tabbody.term"))) post("/cancel", { sid: active.sid });
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); setSide(!sideEl.classList.contains("collapsed")); }
  else if (e.ctrlKey && e.key === "\`") { e.preventDefault(); togglePanelKind("term"); }
});

// ---- connect --------------------------------------------------------------
const es = new EventSource("/events?k=" + k);
es.onopen = () => {
  // Everything is replayed on (re)connect: start each view from a clean slate.
  for (const v of views.values()) {
    v.logEl.innerHTML = ""; v.curText = null; v.curThought = null; v.asks.clear();
    for (const t of v.terms.values()) { t.out.innerHTML = ""; t.cur = null; t.lines = 0; }
  }
};
es.onmessage = (e) => handle(JSON.parse(e.data));
es.onerror = () => { $("status").textContent = "reconnecting…"; };
`;

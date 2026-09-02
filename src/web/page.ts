// The entire web client: one self-contained page, styled like the TUI.
// Served by webui.ts; talks SSE (/events) + JSON POSTs. No dependencies.

export const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tinycoder</title>
<style>
  :root {
    --bg: #0b0d0e; --fg: #d6dbde; --dim: #6b7480; --gray: #4a525c;
    --accent: #35bfd4; --yellow: #e0af68; --red: #f7768e; --green: #9ece6a;
    --magenta: #bb9af7; --box: #14181a; --sel: #1a7f94;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  #wrap { max-width: 920px; margin: 0 auto; padding: 20px 16px 170px; }
  #logo { color: var(--accent); white-space: pre; font-size: 11px; line-height: 1.15; margin: 8px 0 2px; }
  #logo .coder { color: var(--dim); }
  #log { margin-top: 16px; }
  .user { border-left: 3px solid var(--accent); background: var(--box); padding: 8px 12px; margin: 18px 0 10px; font-weight: 600; white-space: pre-wrap; }
  .thought { color: var(--gray); white-space: nowrap; overflow: hidden; margin-top: 4px; }
  .md { white-space: normal; }
  .md p { margin: 6px 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; line-height: 1.3; color: #eef3f5; }
  .md h1 { font-size: 1.3em; } .md h2 { font-size: 1.17em; } .md h3 { font-size: 1.06em; }
  .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md strong { color: #eef3f5; }
  .md code { background: #1b2124; padding: 1px 5px; border-radius: 3px; color: var(--yellow); }
  .md pre { background: #11161a; border: 1px solid #232a2f; border-radius: 4px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  .md pre code { background: none; padding: 0; color: var(--fg); }
  .md table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; }
  .md th, .md td { border: 1px solid #232a2f; padding: 4px 10px; text-align: left; }
  .md th { background: #171d20; color: #eef3f5; }
  .md blockquote { border-left: 3px solid #2c343a; margin: 8px 0; padding-left: 12px; color: var(--dim); }
  .md hr { border: 0; border-top: 1px solid #232a2f; margin: 12px 0; }
  .md a { color: var(--accent); }
  .tool { color: var(--dim); margin-top: 4px; }
  .tool .name { color: var(--accent); font-weight: 600; }
  .result { color: var(--dim); padding-left: 16px; }
  .result.err { color: var(--red); }
  .plan { background: var(--box); border-left: 3px solid var(--accent); padding: 8px 12px; margin: 10px 0; }
  .plan .hdr { font-weight: 700; } .plan .hdr small { color: var(--dim); font-weight: 400; }
  .plan .done { color: var(--gray); text-decoration: line-through; }
  .plan .cur { color: var(--accent); font-weight: 600; }
  .plan .todo { color: var(--dim); }
  .turnend { color: var(--gray); margin: 8px 0 4px; }
  .line-status { color: var(--gray); } .line-warn { color: var(--yellow); } .line-error { color: var(--red); }
  #busy { color: var(--dim); display: none; }
  #busy.on { display: block; }
  #busy .spin { display: inline-block; color: var(--accent); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .ask { background: var(--box); border-left: 3px solid var(--yellow); padding: 10px 12px; margin: 10px 0; }
  .ask .cmd { font-weight: 700; }
  .ask button, .ask .opt { margin: 6px 8px 0 0; background: #1e2428; color: var(--fg); border: 1px solid #2c343a; padding: 4px 12px; cursor: pointer; font: inherit; border-radius: 3px; }
  .ask button:hover, .ask .opt:hover { border-color: var(--accent); }
  .ask .opt.current { border-color: var(--green); }
  .ask .opt .hint { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .ask > .hint { color: var(--dim); font-size: 12px; margin-top: 2px; }
  #bottom { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg); padding: 8px 16px 14px; }
  #bottom .inner { max-width: 920px; margin: 0 auto; position: relative; }
  #menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--box); border: 1px solid #232a2f; display: none; }
  #menu .item { padding: 4px 10px; cursor: pointer; }
  #menu .item .nm { font-weight: 700; } #menu .item .ds { color: var(--dim); margin-left: 10px; }
  #menu .item.sel { background: var(--sel); color: #f2f7f8; }
  #menu .item.sel .ds { color: #c8dde2; }
  #inputbox { border-left: 3px solid var(--accent); background: var(--box); padding: 8px 12px; }
  .inputrow { display: flex; align-items: flex-end; gap: 10px; }
  #input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; resize: none; }
  #actionbtn { flex: none; background: #1e2428; color: var(--dim); border: 1px solid #2c343a; padding: 3px 14px; cursor: pointer; font: inherit; font-size: 12px; border-radius: 3px; }
  #actionbtn:hover { border-color: var(--accent); color: var(--accent); }
  #actionbtn.stop { color: var(--red); border-color: #3d2d31; }
  #actionbtn.stop:hover { border-color: var(--red); color: var(--red); }
  #status { margin-top: 6px; font-size: 12.5px; color: var(--dim); }
  #status .mode { font-weight: 700; }
  #status .mode.edit { color: var(--accent); } #status .mode.bypass { color: var(--red); } #status .mode.ro { color: var(--magenta); }
  #status .eff { color: var(--yellow); } #status .plan-chip { color: var(--accent); } #status .plan-chip.done { color: var(--green); }
  #hint { font-size: 12px; color: var(--gray); margin-top: 4px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="logo">████████╗██╗███╗   ██╗██╗   ██╗
╚══██╔══╝██║████╗  ██║╚██╗ ██╔╝
   ██║   ██║██╔██╗ ██║ ╚████╔╝
   ██║   ██║██║╚██╗██║  ╚██╔╝
   ██║   ██║██║ ╚████║   ██║
   ╚═╝   ╚═╝╚═╝  ╚═══╝   ╚═╝   <span class="coder">coder — web</span></div>
  <div id="log"></div>
  <div id="busy"><span class="spin">⠋</span> <span id="busylabel">thinking…</span> <span id="busysecs"></span></div>
</div>
<div id="bottom"><div class="inner">
  <div id="menu"></div>
  <div id="inputbox">
    <div class="inputrow">
      <textarea id="input" rows="1" placeholder='Ask anything… "/" for commands'></textarea>
      <button id="actionbtn" title="send (enter)">send</button>
    </div>
    <div id="status">connecting…</div>
  </div>
  <div id="hint"><span id="ws"></span> &nbsp; / commands · shift+tab mode · enter send · esc cancel</div>
</div></div>
<script>
const k = new URLSearchParams(location.search).get("k") || "";
const log = document.getElementById("log");
const busyEl = document.getElementById("busy");
const actionBtn = document.getElementById("actionbtn");
let isBusy = false;
let state = { commands: [] };
let curText = null, curThought = null, busyTimer = null, busyStart = 0;
let thoughtBuf = "", thoughtStart = 0;
function endThought() {
  if (curThought) {
    curThought.textContent = "✦ thought for " + ((Date.now() - thoughtStart) / 1000).toFixed(1) + "s";
    curThought = null; thoughtBuf = "";
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

// ---- markdown ----------------------------------------------------------
// Model output is untrusted: escape everything first, then build tags
// ourselves. Nothing from the model is ever inserted as raw HTML.
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inlineMd(s) {
  const codes = [];
  s = s.replace(/\`([^\`]+)\`/g, (m, c) => { codes.push(c); return "\\u0000" + (codes.length - 1) + "\\u0000"; });
  s = s.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)"]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\\u0000(\\d+)\\u0000/g, (m, i) => "<code>" + codes[i] + "</code>");
  return s;
}
function renderMarkdown(src) {
  const lines = esc(src).split("\\n");
  let out = "", i = 0, listType = null;
  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const cells = (row) => row.trim().replace(/^\\||\\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\\s*\`\`\`(\\w*)\\s*$/.exec(line);
    if (fence) {
      closeList();
      const body = []; i++;
      while (i < lines.length && !/^\\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out += "<pre><code>" + body.join("\\n") + "</code></pre>";
      continue;
    }
    if (/^\\s*\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|?[\\s:|-]+\\|[\\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\\s*\\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += "<table><thead><tr>" + head.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
      for (const r of rows) out += "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>";
      out += "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\\s+(.*)$/.exec(line);
    if (h) { closeList(); out += "<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\-*_]*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }
    // NB: lines are already escaped, so the blockquote marker is "&gt;".
    if (/^\\s*&gt;\\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^\\s*&gt;\\s?/.test(lines[i])) { body.push(lines[i].replace(/^\\s*&gt;\\s?/, "")); i++; }
      out += "<blockquote>" + inlineMd(body.join(" ")) + "</blockquote>";
      continue;
    }
    const ul = /^\\s*[-*+]\\s+(.*)$/.exec(line);
    const ol = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
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
           !/^(\\s*#{1,6}\\s|\\s*\`\`\`|\\s*>\\s?|\\s*[-*+]\\s|\\s*\\d+[.)]\\s|\\s*\\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    out += "<p>" + inlineMd(para.join(" ")) + "</p>";
  }
  closeList();
  return out;
}
// Streaming: accumulate raw markdown on the element, re-render on a short
// timer. NOT requestAnimationFrame — rAF never fires in background tabs, so a
// response streamed while the tab is hidden would never render.
function scheduleMd(target) {
  if (target._pending) return;
  target._pending = true;
  setTimeout(() => {
    target._pending = false;
    target.innerHTML = renderMarkdown(target._raw || "");
    window.scrollTo(0, document.body.scrollHeight);
  }, 60);
}
function add(e) { log.appendChild(e); window.scrollTo(0, document.body.scrollHeight); return e; }
function post(path, body) { return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }

function setBusy(label) {
  // The one button right of the input is send when idle, stop while running.
  isBusy = !!label;
  actionBtn.textContent = isBusy ? "■ stop" : "send";
  actionBtn.className = isBusy ? "stop" : "";
  actionBtn.title = isBusy ? "interrupt the agent (esc)" : "send (enter)";
  if (label) {
    busyEl.classList.add("on"); busyStart = Date.now();
    document.getElementById("busylabel").textContent = label + "…";
    if (!busyTimer) busyTimer = setInterval(() => {
      const s = Math.floor((Date.now() - busyStart) / 1000);
      document.getElementById("busysecs").textContent = s > 2 ? s + "s" : "";
    }, 500);
  } else {
    busyEl.classList.remove("on");
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    document.getElementById("busysecs").textContent = "";
  }
  window.scrollTo(0, document.body.scrollHeight);
}

function renderState(s) {
  state = Object.assign(state, s);
  const st = document.getElementById("status");
  st.innerHTML = "";
  const mode = el("span", "mode " + s.mode, s.mode === "ro" ? "read-only" : s.mode === "bypass" ? "bypass permissions" : s.mode);
  st.appendChild(mode);
  st.appendChild(document.createTextNode(" · " + s.model + " (" + s.backend + ")"));
  if (s.effort) { st.appendChild(document.createTextNode(" · ")); st.appendChild(el("span", "eff", s.effort)); }
  const kt = s.ctxTokens < 1000 ? s.ctxTokens : (s.ctxTokens / 1000).toFixed(1) + "k";
  st.appendChild(document.createTextNode(" · " + kt + " (" + s.ctxPct + "%)"));
  if (s.plan) {
    st.appendChild(document.createTextNode(" · "));
    const done = s.plan.steps.filter(x => x.done).length;
    const chip = el("span", "plan-chip" + (s.plan.current < 0 ? " done" : ""), "plan " + done + "/" + s.plan.steps.length);
    st.appendChild(chip);
  }
  if (s.tasks) st.appendChild(document.createTextNode(" · " + s.tasks + " task" + (s.tasks > 1 ? "s" : "")));
  document.getElementById("ws").textContent = s.workspace || "";
}

function renderPlan(p) {
  const box = el("div", "plan");
  const done = p.steps.filter(x => x.done).length;
  const hdr = el("div", "hdr", "Plan ");
  hdr.appendChild(el("small", "", done + "/" + p.steps.length));
  box.appendChild(hdr);
  p.steps.forEach((s, i) => {
    const cls = s.done ? "done" : i === p.current ? "cur" : "todo";
    const mark = s.done ? "✔ " : i === p.current ? "▶ " : "○ ";
    box.appendChild(el("div", cls, mark + s.text));
  });
  add(box);
}

function handle(m) {
  switch (m.t) {
    case "state": renderState(m.s); break;
    case "user": endThought(); curText = null; add(el("div", "user", m.s)); break;
    case "token":
      endThought();
      if (!curText) { curText = add(el("div", "md")); curText._raw = ""; }
      curText._raw += m.s; scheduleMd(curText); break;
    case "thinking":
      if (!curThought) { curThought = add(el("div", "thought")); thoughtStart = Date.now(); thoughtBuf = ""; curText = null; }
      thoughtBuf += m.s;
      if (thoughtBuf.length > 4000) thoughtBuf = thoughtBuf.slice(-2000);
      var tt = thoughtBuf.replace(/\\s+/g, " ").trim();
      curThought.textContent = "✦ " + (tt.length > 160 ? "…" + tt.slice(-160) : tt);
      window.scrollTo(0, document.body.scrollHeight); break;
    case "tool": {
      endThought(); curText = null;
      const d = el("div", "tool"); d.appendChild(el("span", "name", "→ " + m.name)); d.appendChild(document.createTextNode(" " + (m.summary || "")));
      add(d); break;
    }
    case "result": endThought(); curText = null; add(el("div", "result" + (m.err ? " err" : ""), (m.err ? "✗ " : "✓ ") + m.line + (m.extra ? " (+" + m.extra + " lines)" : ""))); break;
    case "plan": endThought(); curText = null; renderPlan(m); break;
    case "line": endThought(); curText = null; add(el("div", "line-" + m.kind, m.s)); break;
    case "turnend": endThought(); curText = null; add(el("div", "turnend", "■ " + m.label)); break;
    case "busy": setBusy(m.label); break;
    case "confirm": {
      endThought(); curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "", "run?")); box.appendChild(el("div", "cmd", m.command));
      if (m.reason) box.appendChild(el("div", "hint", m.reason));
      ["yes", "no", "always"].forEach(a => {
        const b = el("button", "", a === "always" ? "always allow this program" : a);
        b.onclick = () => { post("/confirm", { id: m.id, answer: a }); box.remove(); add(el("div", "line-status", a + " — " + m.command)); };
        box.appendChild(b);
      });
      add(box); break;
    }
    case "select": {
      endThought(); curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      m.options.forEach((o, i) => {
        const b = el("button", "opt" + (o.current ? " current" : ""), (o.current ? "● " : "") + o.label);
        if (o.hint) b.appendChild(el("span", "hint", o.hint));
        b.onclick = () => { post("/select", { id: m.id, index: i }); box.remove(); };
        box.appendChild(el("div")).appendChild(b);
      });
      const cancel = el("button", "", "cancel");
      cancel.onclick = () => { post("/select", { id: m.id, index: null }); box.remove(); };
      box.appendChild(cancel);
      add(box); break;
    }
  }
}

const input = document.getElementById("input");
const menu = document.getElementById("menu");
let menuIdx = 0;
function menuItems() {
  const v = input.value;
  if (!v.startsWith("/") || v.includes(" ") || v.includes("\\n")) return [];
  return (state.commands || []).filter(c => c.name.startsWith(v.slice(1)));
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
  let v = input.value;
  const items = menuItems();
  if (items.length) v = "/" + items[menuIdx].name;
  v = v.trim();
  if (!v) return;
  input.value = ""; renderMenu();
  post("/msg", { text: v });
}
input.addEventListener("input", () => { menuIdx = 0; renderMenu(); autoGrow(); });
function autoGrow() { input.rows = Math.min(6, Math.max(1, input.value.split("\\n").length)); }
input.addEventListener("keydown", (e) => {
  const items = menuItems();
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); post("/cycle"); }
  else if (e.key === "Tab" && items.length) { e.preventDefault(); input.value = "/" + items[menuIdx].name + " "; renderMenu(); }
  else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); menuIdx = (menuIdx - 1 + items.length) % items.length; renderMenu(); }
  else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); menuIdx = (menuIdx + 1) % items.length; renderMenu(); }
  else if (e.key === "Escape") { if (input.value) { input.value = ""; renderMenu(); } else post("/cancel"); }
});

actionBtn.onclick = () => { if (isBusy) post("/cancel"); else submit(); };

// Escape interrupts from anywhere on the page, not only from the input box.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== input) post("/cancel");
});

const es = new EventSource("/events?k=" + k);
es.onopen = () => { log.innerHTML = ""; };
es.onmessage = (e) => handle(JSON.parse(e.data));
es.onerror = () => { document.getElementById("status").textContent = "reconnecting…"; };
input.focus();
</script>
</body>
</html>`;

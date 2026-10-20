// The settings dialog (gear in the top bar): model servers and their API
// keys, other machines, the defaults a new session starts with, and the
// page's own appearance. Appended to the page script, so it shares its
// helpers ($, el, post, k). Same rules as client.ts: plain JS in String.raw,
// no template literals, and page text only ever goes in via textContent.

// Runs in <head>, before the first paint, so a light page never flashes dark.
export const THEME_BOOT = String.raw`
try {
  var t = localStorage.getItem("smol.theme"), f = localStorage.getItem("smol.fontsize");
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  if (t === "light") document.documentElement.dataset.theme = "light";
  if (f === "small" || f === "large") document.documentElement.dataset.fontsize = f;
} catch (e) {}
`;

export const SETTINGS_CSS = String.raw`
  :root[data-fontsize="small"] #logs, :root[data-fontsize="small"] #input { font-size: 13px; }
  :root[data-fontsize="large"] #logs, :root[data-fontsize="large"] #input { font-size: 16px; }
  .dlg.settings { width: min(760px, 94vw); height: min(620px, 86vh); padding: 0; color: var(--fg); }
  .dlg.settings::backdrop { background: rgba(0,0,0,.45); }
  .settings .sethdr { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); font-weight: 600; }
  .settings .setbody { display: flex; flex: 1; min-height: 0; }
  .settings .settabs { flex: none; width: 150px; border-inline-end: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 2px; }
  .settings .settabs button { text-align: start; background: transparent; border: 1px solid transparent; color: var(--dim); border-radius: 5px; padding: 6px 10px; cursor: pointer; }
  .settings .settabs button:hover { color: var(--fg); background: var(--hover-bg); }
  .settings .settabs button[aria-selected="true"] { color: var(--fg); background: var(--active-bg); border-color: var(--line); }
  .settings .setpane { flex: 1; min-width: 0; overflow-y: auto; padding: 14px 18px 20px; }
  .settings h3 { font-size: 13px; margin: 14px 0 8px; display: flex; align-items: center; gap: 8px; }
  .settings h3:first-child { margin-top: 0; }
  .settings .hint { color: var(--dim); font-size: 12.5px; margin: 4px 0 10px; }
  .settings .srow { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 6px 0; background: var(--box); }
  .settings .srow .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .settings .srow .nm { font-weight: 600; }
  .settings .srow .where, .settings .srow .url { color: var(--dim); font-size: 12.5px; }
  .settings .srow .url { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; direction: ltr; }
  .settings .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: none; }
  .settings .dot.locked { background: var(--yellow); }
  .settings .state { font-size: 12.5px; color: var(--dim); }
  .settings .state.locked { color: var(--yellow); }
  .settings .keyform, .settings .inline { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .settings input[type="text"], .settings input[type="password"], .settings select { background: var(--input-bg); color: var(--fg); border: 1px solid var(--input-border); border-radius: 5px; padding: 5px 8px; font: inherit; min-width: 0; }
  .settings input[type="text"], .settings input[type="password"] { flex: 1; min-width: 180px; }
  .settings input:focus, .settings select:focus { outline: 2px solid var(--accent-ring); border-color: var(--input-focus); }
  .settings button.small { background: var(--btn-bg); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  .settings button.small:hover { border-color: var(--border-strong); }
  .settings button.small.danger { color: var(--red); }
  .settings .msg { font-size: 12.5px; margin-top: 6px; }
  .settings .msg.err { color: var(--red); } .settings .msg.ok { color: var(--green); } .settings .msg.warn { color: var(--yellow); }
  .settings .field { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; align-items: center; margin: 8px 0; }
  .settings .field select { width: 100%; }
  .settings .choices { display: flex; gap: 6px; flex-wrap: wrap; }
  .settings .choices label { border: 1px solid var(--line); border-radius: 5px; padding: 5px 12px; cursor: pointer; background: var(--box); }
  .settings .choices input { margin-inline-end: 6px; }
  .settings .loading { color: var(--dim); padding: 10px 0; }
  .settings .toggle { display: flex; align-items: center; gap: 6px; margin: 4px 0 10px; cursor: pointer; }
  @media (max-width: 600px) { .settings .setbody { flex-direction: column; } .settings .settabs { width: auto; flex-direction: row; border-inline-end: 0; border-bottom: 1px solid var(--line); } .settings .field { grid-template-columns: 1fr; } }
`;

export const SETTINGS_JS = String.raw`
// ---- settings dialog --------------------------------------------------------
function getJSON(path) { return fetch(path + "?k=" + k).then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || r.statusText); return b; })); }
function postJSON(path, body) {
  return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || r.statusText); return b; }));
}
function store(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { console.warn("[settings] storage unavailable", e); } }
function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
const lightQuery = matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  let t = stored("smol.theme") || "dark";
  if (t === "system") t = lightQuery.matches ? "light" : "dark";
  if (t === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  const f = stored("smol.fontsize");
  if (f === "small" || f === "large") document.documentElement.dataset.fontsize = f; else delete document.documentElement.dataset.fontsize;
}
lightQuery.addEventListener("change", applyTheme);
function msg(box, text, kind) { box.textContent = text || ""; box.className = "msg" + (kind ? " " + kind : ""); }
function smallBtn(text, cls) { const b = el("button", "small" + (cls ? " " + cls : ""), text); b.type = "button"; return b; }

function serverRow(s, refresh) {
  const row = el("div", "srow");
  const top = el("div", "top");
  top.appendChild(el("span", "dot" + (s.locked ? " locked" : "")));
  top.appendChild(el("span", "nm", s.name));
  top.appendChild(el("span", "where", s.host ? "on " + s.host : "this computer"));
  top.appendChild(el("span", "url", s.baseUrl));
  top.appendChild(el("span", "grow"));
  top.appendChild(el("span", "state" + (s.locked ? " locked" : ""), s.locked ? "needs its API key" : s.models + (s.models === 1 ? " model" : " models")));
  row.appendChild(top);
  if (!s.keyed) return row;
  const keyBtn = smallBtn(s.hasKey ? "Change API key" : "API key");
  top.appendChild(keyBtn);
  const form = el("div", "keyform"); form.hidden = !s.locked;
  const field = el("input"); field.type = "password"; field.autocomplete = "off"; field.placeholder = "the key set in " + s.name + "'s settings"; field.setAttribute("aria-label", "API key for " + s.name);
  const save = smallBtn("Save"), note = el("div", "msg");
  form.appendChild(field); form.appendChild(save);
  // A key for a server on the network travels in the clear unless it is https.
  if (!/^https:/.test(s.baseUrl) && !/^https?:\/\/(localhost|127(\.\d+){3}|\[::1\])([:\/]|$)/.test(s.baseUrl))
    form.appendChild(el("div", "hint", "This connection is plain http: the key travels unencrypted, so it is only as safe as that network."));
  if (s.hasKey) {
    const remove = smallBtn("Remove key", "danger");
    remove.onclick = () => postJSON("/settings/key", { baseUrl: s.baseUrl, key: null }).then(refresh, (e) => msg(note, e.message, "err"));
    form.appendChild(remove);
  }
  keyBtn.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) field.focus(); };
  const submit = () => {
    if (!field.value.trim()) return msg(note, "Paste the key first.", "warn");
    save.disabled = true; msg(note, "Checking the key with " + s.name + "…");
    postJSON("/settings/key", { baseUrl: s.baseUrl, key: field.value })
      .then((r) => { if (r.ok) refresh(); else { save.disabled = false; msg(note, r.error, "err"); } },
            (e) => { save.disabled = false; console.error("[settings] key", e); msg(note, "Could not save the key: " + e.message, "err"); });
  };
  save.onclick = submit;
  field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  row.appendChild(form); row.appendChild(note);
  return row;
}

function machineRow(h, refresh) {
  const row = el("div", "srow"), top = el("div", "top");
  top.appendChild(el("span", "nm", h.name || h.address));
  if (h.name) top.appendChild(el("span", "url", h.address));
  top.appendChild(el("span", "grow"));
  const rename = smallBtn("Rename"), remove = smallBtn("Remove", "danger");
  top.appendChild(rename); top.appendChild(remove); row.appendChild(top);
  const note = el("div", "msg");
  rename.onclick = () => {
    const form = el("div", "inline"), field = el("input"); field.type = "text"; field.value = h.name || ""; field.setAttribute("aria-label", "New name");
    const ok = smallBtn("Save");
    ok.onclick = () => postJSON("/settings/machines/rename", { address: h.address, name: field.value }).then(refresh, (e) => msg(note, e.message, "err"));
    field.onkeydown = (e) => { if (e.key === "Enter") ok.onclick(); };
    form.appendChild(field); form.appendChild(ok); row.insertBefore(form, note); field.focus(); rename.disabled = true;
  };
  remove.onclick = () => {
    if (remove.dataset.sure !== "1") { remove.dataset.sure = "1"; remove.textContent = "Remove it?"; return; }
    postJSON("/settings/machines/remove", { address: h.address }).then(refresh, (e) => msg(note, e.message, "err"));
  };
  row.appendChild(note);
  return row;
}

function addMachineForm(refresh) {
  const box = el("div");
  const form = el("div", "inline"), addr = el("input"), add = smallBtn("Add");
  addr.type = "text"; addr.placeholder = "192.168.1.50, gpu-box.local:8000 or https://…"; addr.setAttribute("aria-label", "Address of the machine");
  form.appendChild(addr); form.appendChild(add); box.appendChild(form);
  const keyRow = el("div", "keyform"), key = el("input"), note = el("div", "msg");
  key.type = "password"; key.autocomplete = "off"; key.setAttribute("aria-label", "API key"); keyRow.appendChild(key); keyRow.hidden = true;
  box.appendChild(keyRow); box.appendChild(note);
  let outsideOk = false;
  const submit = () => {
    if (!addr.value.trim()) return msg(note, "Type the address of the machine that runs your models.", "warn");
    add.disabled = true; msg(note, "Checking " + addr.value.trim() + "…");
    postJSON("/settings/machines/add", { address: addr.value, apiKey: keyRow.hidden ? undefined : key.value, outsideOk: outsideOk })
      .then((r) => {
        add.disabled = false;
        if (r.status === "added") { msg(note, "Added " + r.name + " — " + r.summary, "ok"); addr.value = ""; key.value = ""; keyRow.hidden = true; outsideOk = false; refresh(); }
        else if (r.status === "needs-key") { keyRow.hidden = false; key.placeholder = "API key for " + r.name; key.focus(); msg(note, r.message + " Paste it and press Add.", "warn"); }
        else if (r.status === "outside") { outsideOk = true; add.textContent = "Add anyway"; msg(note, r.message, "warn"); }
        else msg(note, r.message, "err");
      }, (e) => { add.disabled = false; console.error("[settings] add machine", e); msg(note, "Could not add it: " + e.message, "err"); });
  };
  add.onclick = submit;
  addr.onkeydown = key.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  addr.oninput = () => { outsideOk = false; add.textContent = "Add"; };
  return box;
}

function modelsPane(pane) {
  const load = () => {
    pane.replaceChildren();
    const h = el("h3", "", "Model servers"), again = smallBtn("Refresh"); h.appendChild(el("span", "grow")); h.appendChild(again); again.onclick = load;
    pane.appendChild(h);
    const list = el("div", "loading", "Looking for model servers…"); pane.appendChild(list);
    const h2 = el("h3", "", "Other machines"); pane.appendChild(h2);
    pane.appendChild(el("div", "hint", "Machines on your network or VPN that run Ollama, LM Studio, oMLX or MTPLX."));
    const machines = el("div"); pane.appendChild(machines);
    pane.appendChild(addMachineForm(load));
    getJSON("/settings").then((v) => {
      list.className = ""; list.textContent = "";
      if (!v.servers.length) {
        list.appendChild(el("div", "hint", "No model server answered. Start Ollama, LM Studio, oMLX or MTPLX (or add a machine below), then Refresh."));
      } else v.servers.forEach((s) => list.appendChild(serverRow(s, load)));
      if (!v.hosts.length) machines.appendChild(el("div", "hint", "None added yet."));
      v.hosts.forEach((m) => machines.appendChild(machineRow(m, load)));
    }, (e) => {
      console.error("[settings] load", e);
      list.className = "msg err"; list.textContent = "Could not load the servers: " + e.message;
    });
  };
  load();
}

function dropdown(options, value) {
  const s = el("select");
  options.forEach((o) => { const opt = el("option", "", o[1]); opt.value = o[0]; if (o[0] === value) opt.selected = true; s.appendChild(opt); });
  return s;
}

function defaultsPane(pane) {
  pane.replaceChildren();
  pane.appendChild(el("h3", "", "New sessions start with"));
  pane.appendChild(el("div", "hint", "Sessions that are already open keep their own settings. Bypass mode is always chosen per session."));
  const body = el("div", "loading", "Looking for models…"); pane.appendChild(body);
  const note = el("div", "msg"); pane.appendChild(note);
  getJSON("/settings").then((v) => {
    body.className = ""; body.textContent = "";
    const field = (label, control) => { const f = el("div", "field"); const l = el("label", "", label); f.appendChild(l); f.appendChild(control); body.appendChild(f); return control; };
    const d = v.defaults;
    const opts = v.models.map((m, i) => [String(i), m.id + " — " + m.backend + (m.host ? " @ " + m.host : "")]);
    let current = v.models.findIndex((m) => m.id === d.model && (!d.modelUrl || m.baseUrl === d.modelUrl));
    if (current < 0) current = v.models.findIndex((m) => m.id === d.model);
    if (!v.models.length) opts.push(["", "no models found — start a model server"]);
    else if (current < 0) opts.unshift(["", d.model ? d.model + " (not available now)" : "the first one found"]);
    const model = field("Model", dropdown(opts, current >= 0 ? String(current) : ""));
    const effort = field("Reasoning effort", dropdown([["", "Model default"], ["off", "Off — fastest"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]], d.effort || ""));
    const mode = field("Permission mode", dropdown([["ro", "Read-only"], ["edit", "Edit"]], d.mode === "ro" ? "ro" : "edit"));
    const save = (patch) => postJSON("/settings/defaults", patch).then(() => msg(note, "Saved.", "ok"), (e) => { console.error("[settings] defaults", e); msg(note, "Could not save: " + e.message, "err"); });
    model.onchange = () => { const m = v.models[Number(model.value)]; if (m) save({ model: m.id, modelUrl: m.baseUrl }); };
    effort.onchange = () => save({ effort: effort.value || null });
    mode.onchange = () => save({ mode: mode.value });
  }, (e) => { console.error("[settings] load", e); body.className = "msg err"; body.textContent = "Could not load the defaults: " + e.message; });
}

function choices(name, options, value, onPick) {
  const box = el("div", "choices");
  options.forEach((o) => {
    const label = el("label"), radio = el("input"); radio.type = "radio"; radio.name = name; radio.value = o[0]; radio.checked = o[0] === value;
    radio.onchange = () => onPick(o[0]);
    label.appendChild(radio); label.appendChild(document.createTextNode(o[1])); box.appendChild(label);
  });
  return box;
}

function appearancePane(pane) {
  pane.replaceChildren();
  pane.appendChild(el("h3", "", "Theme"));
  pane.appendChild(choices("theme", [["dark", "Dark"], ["light", "Light"], ["system", "Match system"]], stored("smol.theme") || "dark", (t) => { store("smol.theme", t === "dark" ? null : t); applyTheme(); }));
  pane.appendChild(el("h3", "", "Text size"));
  pane.appendChild(choices("fontsize", [["small", "Small"], ["normal", "Normal"], ["large", "Large"]], stored("smol.fontsize") || "normal", (f) => { store("smol.fontsize", f === "normal" ? null : f); applyTheme(); }));
  pane.appendChild(el("div", "hint", "Saved in this browser only."));
}

function webPane(pane) {
  pane.replaceChildren();
  pane.appendChild(el("h3", "", "Web access"));
  pane.appendChild(el("div", "hint", "Lets the model search the web and read pages as plain text — no browser, no cookies, nothing saved. While off, the two tools are not sent to the model at all, so they cost no context. Never available in bypass mode."));
  const body = el("div", "loading", "Checking…"), note = el("div", "msg");
  pane.appendChild(body); pane.appendChild(note);
  const send = (patch) => postJSON("/settings/web", patch).then((v) => { render(v); msg(note, "Saved.", "ok"); }, (e) => { console.error("[settings] web", e); msg(note, e.message, "err"); });
  const render = (w) => {
    body.className = ""; body.replaceChildren();
    const toggle = el("label", "toggle"), box = el("input"); box.type = "checkbox"; box.checked = !!w.enabled;
    toggle.appendChild(box); toggle.appendChild(document.createTextNode(" Let the model search the web and read pages"));
    box.onchange = () => send({ enabled: box.checked });
    body.appendChild(toggle);
    body.appendChild(el("h3", "", "Search with"));
    body.appendChild(choices("provider", [["brave", "Brave Search"], ["searxng", "SearXNG"]], w.provider, (p) => send({ provider: p })));
    const state = el("div", "msg");
    if (w.provider === "brave") {
      body.appendChild(el("div", "hint", "Paste a key from Brave's API dashboard: about 1,000 searches a month are free. Searches go to Brave's servers."));
      const link = el("a", "", "Get a key at api-dashboard.search.brave.com"); link.href = "https://api-dashboard.search.brave.com/"; link.target = "_blank"; link.rel = "noopener";
      body.appendChild(link);
      const row = el("div", "keyform"), key = el("input"), save = smallBtn(w.hasBraveKey ? "Replace key" : "Save key");
      key.type = "password"; key.autocomplete = "off"; key.placeholder = w.hasBraveKey ? "a key is saved — paste a new one to replace it" : "Brave Search API key"; key.setAttribute("aria-label", "Brave Search API key");
      row.appendChild(key); row.appendChild(save);
      if (w.hasBraveKey) { const rm = smallBtn("Remove key", "danger"); rm.onclick = () => send({ braveKey: "" }); row.appendChild(rm); }
      body.appendChild(row);
      const submit = () => { if (!key.value.trim()) return msg(note, "Paste the key first.", "warn"); save.disabled = true; msg(note, "Checking the key with Brave…"); send({ braveKey: key.value }).then(() => { save.disabled = false; }); };
      save.onclick = submit;
      key.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
      if (w.status === "ok") msg(state, "Brave accepted the key.", "ok");
      else if (w.status === "key-saved") msg(state, "A key is saved.", "ok");
      else msg(state, "No key yet: paste one to search with Brave.", w.enabled ? "warn" : "");
    } else {
      body.appendChild(el("div", "hint", "A search server you run yourself: it asks Google, Bing, Brave and others for you, with no account. The most private option."));
      const row = el("div", "inline"), addr = el("input"), save = smallBtn("Save");
      addr.type = "text"; addr.value = w.searxng; addr.setAttribute("aria-label", "SearXNG address");
      row.appendChild(addr); row.appendChild(save); body.appendChild(row);
      save.onclick = () => send({ searxng: addr.value });
      addr.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); send({ searxng: addr.value }); } };
      if (w.status === "ok") msg(state, "SearXNG answers at " + w.searxng + ".", "ok");
      else if (w.status === "json-off") msg(state, "SearXNG answers, but its JSON output is off: add json under search: formats: in its settings.yml, then restart it.", "warn");
      else msg(state, "Nothing answered at " + w.searxng + ". Start SearXNG (see the README's Web access section), then come back here.", w.enabled ? "err" : "");
    }
    body.appendChild(state);
  };
  getJSON("/settings/web").then(render, (e) => { console.error("[settings] web", e); body.className = "msg err"; body.textContent = "Could not load: " + e.message; });
}

function openSettings(tab) {
  const dialog = document.createElement("dialog"); dialog.className = "dlg settings"; dialog.setAttribute("aria-label", "Settings");
  const hdr = el("div", "sethdr"); hdr.appendChild(el("span", "", "Settings")); hdr.appendChild(el("span", "grow"));
  const close = el("button", "iconbtn", "×"); close.title = "close"; close.setAttribute("aria-label", "Close settings"); close.onclick = () => dialog.close(); hdr.appendChild(close);
  const body = el("div", "setbody"), tabs = el("div", "settabs"), pane = el("div", "setpane");
  tabs.setAttribute("role", "tablist");
  const panes = { models: ["Models", modelsPane], defaults: ["Defaults", defaultsPane], web: ["Web", webPane], appearance: ["Appearance", appearancePane] };
  const show = (name) => { for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === name)); panes[name][1](pane); };
  Object.keys(panes).forEach((name) => { const b = el("button", "", panes[name][0]); b.type = "button"; b.dataset.tab = name; b.setAttribute("role", "tab"); b.onclick = () => show(name); tabs.appendChild(b); });
  body.appendChild(tabs); body.appendChild(pane); dialog.appendChild(hdr); dialog.appendChild(body);
  // Esc closes the dialog and goes no further: the page-level handler would
  // read it as "cancel the running turn".
  dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dialog.close(); } });
  document.body.appendChild(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal();
  show(tab || "models");
}
$("btnsettings").onclick = () => openSettings();
`;

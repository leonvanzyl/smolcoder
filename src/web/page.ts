// The web page: one self-contained HTML document (styles + script inlined,
// no dependencies) served by the hub. Structure only — the styling lives in
// styles.ts and the behaviour in client.ts.

import { CLIENT_JS } from "./client";
import { STYLES } from "./styles";

const LOGO = `███████╗ ███╗   ███╗  ██████╗  ██╗
██╔════╝ ████╗ ████║ ██╔═══██╗ ██║
███████╗ ██╔████╔██║ ██║   ██║ ██║
╚════██║ ██║╚██╔╝██║ ██║   ██║ ██║
███████║ ██║ ╚═╝ ██║ ╚██████╔╝ ███████╗
╚══════╝ ╚═╝     ╚═╝  ╚═════╝  ╚══════╝`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230b0d0e'/%3E%3Ctext x='16' y='23' font-size='19' font-family='monospace' font-weight='700' text-anchor='middle' fill='%2335bfd4'%3ES%3C/text%3E%3C/svg%3E";

const ICON_BROWSER =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const ICON_TERMINAL =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';

export const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smol</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLES}</style>
</head>
<body>
<aside id="side">
  <div class="sidehdr">
    <span class="brand">smol<span class="coder">coder</span></span>
    <span class="grow"></span>
    <button class="iconbtn" id="sidecollapse" title="hide sidebar (ctrl+b)">«</button>
  </div>
  <button id="openfolder" class="ghost">+ Open folder…</button>
  <div id="wslist"></div>
  <div class="sidefoot"><span id="ver"></span><span class="grow"></span><span title="keyboard: ctrl+b sidebar · ctrl+\` terminal · shift+tab mode · esc cancel">keys ?</span></div>
</aside>
<div id="main">
  <div id="top">
    <button class="iconbtn" id="sidetoggle" title="show sidebar (ctrl+b)" hidden>☰</button>
    <div id="crumb"></div>
    <button class="iconbtn" id="btnbrowser" title="browser panel: preview a dev server next to the chat">${ICON_BROWSER}</button>
    <button class="iconbtn" id="btnterm" title="terminal panel (ctrl+\`)">${ICON_TERMINAL}</button>
  </div>
  <div id="logwrap">
    <div id="welcome" hidden>
      <div id="logo">${LOGO}   <span class="coder">coder — web</span></div>
      <p>Pick a session in the sidebar, or open a folder to start one. Each workspace keeps its own sessions; you can run several at once and switch between them while they work.</p>
      <div class="row"><button class="primary" id="welcomeopen">Open a folder…</button></div>
      <div id="recent"></div>
    </div>
    <div id="logs"></div>
    <div id="busywrap"><div id="busy"><span class="spin">⠋</span> <span id="busylabel">thinking…</span> <span id="busysecs"></span></div></div>
  </div>
  <div id="bottom" hidden><div class="inner">
    <div id="menu"></div>
    <div id="inputbox">
      <div class="inputrow">
        <textarea id="input" rows="1" placeholder='Ask anything… "/" for commands'></textarea>
        <button id="actionbtn" title="send (enter)">send</button>
      </div>
      <div id="status">connecting…</div>
    </div>
    <div id="hintrow"><span id="ws"></span> &nbsp; / commands · shift+tab mode · enter send · esc cancel · ctrl+b sidebar · ctrl+\` terminal</div>
  </div></div>
</div>
<div id="panel" hidden>
  <div id="panelgrip" title="drag to resize"></div>
  <div id="paneltabs"></div>
  <div id="panelviews"></div>
</div>
<div id="modal" hidden>
  <div class="dlg">
    <div class="dlghdr">Open a folder as a workspace<span class="grow"></span><button class="iconbtn" id="fsclose" title="close">×</button></div>
    <div class="pathrow"><input id="fspath" spellcheck="false" placeholder="type or paste a path"><button class="ghost" id="fsgo">go</button></div>
    <div id="fsroots"></div>
    <div id="fslist"></div>
    <div class="dlgfoot">
      <button class="primary" id="fsopen">Open this folder</button>
      <label><input type="checkbox" id="fsstart" checked> start a session</label>
      <span class="grow"></span>
      <span>✦ looks like a project · double-click a folder to open it</span>
    </div>
  </div>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;

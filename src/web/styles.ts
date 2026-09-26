// Compact workspace chrome, with monospace reserved for code and commands.

import { LOGO_ROWS } from "../logo";

// The logo as a CSS string: "\A " is a newline whose trailing space is eaten
// by the escape, so each row starts where it should.
const LOGO_CSS = LOGO_ROWS.map((r) => r.trimEnd()).join("\\A ");

export const STYLES = String.raw`
  :root {
    --bg: #111416; --fg: #e1e5e7; --dim: #a0a8ae; --gray: #79838b;
    --accent: #35bfd4; --yellow: #e0af68; --red: #f7768e; --green: #9ece6a;
    --magenta: #bb9af7; --box: #14181a; --sel: #1a7f94; --line: #232a2f; --side: #0e1113;
  }
  * { box-sizing: border-box; }
  /* Class rules below set display; the hidden attribute must still win. */
  [hidden] { display: none !important; }
  /* Scrollbars in the page's own colors (native ones are light and chunky). */
  html { color-scheme: dark; scrollbar-color: #2c343a transparent; }
  * { scrollbar-width: thin; }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2c343a; border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: #3d474f; background-clip: padding-box; }
  ::-webkit-scrollbar-corner { background: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg); display: flex; overflow: hidden;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button { font: inherit; }
  a { color: var(--accent); }
  .grow { flex: 1; }
  .iconbtn { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; border-radius: 4px; padding: 2px 6px; line-height: 1.2; display: inline-flex; align-items: center; gap: 4px; }
  .iconbtn:hover { color: var(--fg); border-color: var(--line); background: #1a2023; }
  .iconbtn.on { color: var(--accent); border-color: var(--line); background: #13202a; }
  .iconbtn svg { display: block; }
  .primary { background: #173f47; color: #eef3f5; border: 1px solid #1f5d68; padding: 5px 12px; border-radius: 4px; cursor: pointer; }
  .primary:hover { border-color: var(--accent); }
  .ghost { background: #151b1e; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 5px 10px; cursor: pointer; }
  .ghost:hover { border-color: var(--accent); }
  .hint { color: var(--dim); font-size: 12px; }

  /* ---- left sidebar ---- */
  #side { width: 272px; flex: none; background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  #side.collapsed { display: none; }
  .sidehdr { display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 14px; }
  /* The SMOL block logo, sized so all 39 columns fit beside the collapse button. */
  .brand { color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 7px; line-height: 1.15; }
  #openfolder { margin: 2px 10px 10px; text-align: left; }
  #wslist { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
  .sidehint { color: var(--dim); font-size: 12px; padding: 8px 10px; }
  .ws { margin: 2px 0 10px; }
  .wshdr { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 8px; border-radius: 4px; color: var(--dim); font-size: 12.5px; }
  .wshdr:hover { background: #141a1d; }
  .wsname { color: var(--fg); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; max-width: 55%; }
  .wspath { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--gray); }
  .wshdr .iconbtn { visibility: hidden; padding: 0 5px; }
  .wshdr:hover .iconbtn { visibility: visible; }
  .sess { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: 4px; cursor: pointer; color: var(--dim); font-size: 13px; }
  .sess:hover { background: #141a1d; color: var(--fg); }
  .sess.active { background: #17232a; color: #eef3f5; }
  .sess .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gray); flex: none; }
  .sess.busy .dot, .sess.starting .dot { background: var(--accent); animation: pulse 1s infinite; }
  .sess.waiting .dot { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .sess.error .dot { background: var(--red); }
  .sess.stored .dot { background: transparent; border: 1px solid var(--gray); }
  .sess.unread .stitle::after { content: " •"; color: var(--accent); }
  .stitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stitle.untitled { font-style: italic; }
  .stitle.renaming { min-width: 0; background: #0b0e10; color: var(--fg); border: 1px solid var(--accent); border-radius: 3px; padding: 1px 5px; font: inherit; outline: none; }
  .stime { font-size: 11px; color: var(--gray); flex: none; }
  .sess .iconbtn { visibility: hidden; padding: 0 5px; }
  .sess:hover .iconbtn { visibility: visible; }
  .sidefoot { padding: 8px 14px; font-size: 11.5px; color: var(--gray); border-top: 1px solid var(--line); display: flex; gap: 10px; }

  /* ---- main column ---- */
  #main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  #top { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--dim); min-height: 40px; }
  #crumb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 4px; }
  #crumb .ws { color: var(--fg); font-weight: 700; }
  #crumb .sep { margin: 0 6px; color: var(--gray); }
  #crumb .model { color: var(--gray); margin-left: 10px; }
  #logwrap { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; overflow-anchor: none; }
  #logs, #busywrap { max-width: 920px; margin: 0 auto; padding: 16px 16px 0; }
  #logs { overflow-wrap: anywhere; }
  #wslist, #fslist, .tabbody.term .out { overflow-x: hidden; }
  #busywrap { padding-bottom: 20px; }
  #welcome { max-width: 920px; margin: 0 auto; padding: 48px 16px; }
  #welcome p { color: var(--dim); max-width: 60ch; }
  #welcome .row { display: flex; gap: 10px; align-items: center; margin: 14px 0 22px; }
  #recent { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .wsbtn { background: transparent; border: 1px solid transparent; color: var(--fg); padding: 4px 8px; border-radius: 4px; cursor: pointer; text-align: left; }
  .wsbtn:hover { border-color: var(--line); background: #141a1d; }
  .wsbtn .dim { color: var(--gray); font-size: 12px; }
  #logo { color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; line-height: 1.15; margin: 8px 0 12px; }
  #logo .coder { color: var(--dim); }

  .user { border-left: 3px solid var(--accent); background: var(--box); padding: 8px 12px; margin: 18px 0 10px; font-weight: 600; white-space: pre-wrap; }
  .thought { color: var(--gray); margin-top: 4px; }
  .thought summary { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; list-style: none; }
  .thought summary::-webkit-details-marker { display: none; }
  .thought summary::before { content: "›"; flex: none; }
  .thought[open] summary::before { content: "⌄"; }
  .thought summary:hover { color: var(--fg); }
  .thought-preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thought-expand, .thought-collapse { flex: none; color: var(--dim); }
  .thought-collapse, .thought[open] .thought-expand { display: none; }
  .thought[open] .thought-collapse { display: inline; }
  .thought-body { color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid var(--line); padding: 8px 12px; margin: 4px 0 12px 4px; line-height: 1.7; }
  .md { white-space: normal; }
  .md p { margin: 6px 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; line-height: 1.3; color: #eef3f5; }
  .md h1 { font-size: 1.3em; } .md h2 { font-size: 1.17em; } .md h3 { font-size: 1.06em; }
  .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md strong { color: #eef3f5; }
  .md code { background: #1b2124; padding: 1px 5px; border-radius: 3px; color: var(--yellow); }
  .md pre { background: #11161a; border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  .md pre code { background: none; padding: 0; color: var(--fg); }
  .md table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; }
  .md th, .md td { border: 1px solid var(--line); padding: 4px 10px; text-align: left; }
  .md th { background: #171d20; color: #eef3f5; }
  .md blockquote { border-left: 3px solid #2c343a; margin: 8px 0; padding-left: 12px; color: var(--dim); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
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
  .line-status { color: var(--gray); white-space: pre-wrap; } .line-warn { color: var(--yellow); white-space: pre-wrap; } .line-error { color: var(--red); white-space: pre-wrap; }
  #busy { color: var(--dim); display: none; }
  #busy.on { display: block; }
  #busy .spin { display: inline-block; color: var(--accent); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .ask { background: var(--box); border-left: 3px solid var(--yellow); padding: 10px 12px; margin: 10px 0; }
  .ask .cmd { font-weight: 700; }
  .ask button, .ask .opt { margin: 6px 8px 0 0; background: #1e2428; color: var(--fg); border: 1px solid #2c343a; padding: 4px 12px; cursor: pointer; font: inherit; border-radius: 3px; }
  .ask button:hover, .ask .opt:hover { border-color: var(--accent); }
  .ask .opt.current { border-color: var(--green); }
  .ask .askinput { margin-top: 8px; width: min(420px, 100%); box-sizing: border-box; background: #14181b; color: var(--fg); border: 1px solid #2c343a; padding: 6px 8px; font: inherit; border-radius: 3px; outline: none; }
  .ask .askinput:focus { border-color: var(--accent); }
  .ask .opt .hint { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .ask > .hint { color: var(--dim); font-size: 12px; margin-top: 2px; }

  #bottom { flex: none; padding: 8px 16px 12px; background: var(--bg); }
  #bottom .inner { max-width: 920px; margin: 0 auto; position: relative; }
  #jumpbottom { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 4; border-radius: 20px; padding: 6px 14px; white-space: nowrap; box-shadow: 0 4px 16px #0006; font-size: 12px; }
  #menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--box); border: 1px solid var(--line); display: none; z-index: 5; }
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
  #hintrow { font-size: 12px; color: var(--gray); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- right panel: browser + terminal tabs ---- */
  #panel { flex: none; width: 520px; min-width: 300px; max-width: 80vw; border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; position: relative; background: var(--side); }
  #panel[hidden] { display: none; }
  #panelgrip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 6; }
  #panelgrip:hover, body.dragging #panelgrip { background: var(--sel); }
  body.dragging { cursor: col-resize; user-select: none; }
  body.dragging iframe { pointer-events: none; }
  #paneltabs { display: flex; align-items: center; gap: 2px; padding: 5px 6px; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; min-height: 40px; }
  .ptab { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 4px; color: var(--dim); cursor: pointer; font-size: 12px; white-space: nowrap; max-width: 210px; border: 1px solid transparent; }
  .ptab:hover { color: var(--fg); background: #141a1d; }
  .ptab.on { color: #eef3f5; background: #17232a; border-color: var(--line); }
  .ptab .ico { color: var(--accent); font-size: 11px; }
  .ptab .lbl { overflow: hidden; text-overflow: ellipsis; }
  .ptab .x { color: var(--gray); padding: 0 2px; }
  .ptab .x:hover { color: var(--red); }
  #panelviews { flex: 1; min-height: 0; display: flex; }
  .panelview { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .panelview[hidden] { display: none; }
  .tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .tabbody[hidden] { display: none; }
  .tabbody.browser .bar { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); align-items: center; flex: none; }
  .tabbody.browser .bar input { flex: 1; min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12.5px; padding: 3px 8px; border-radius: 4px; outline: 0; }
  .tabbody.browser .bar input:focus { border-color: var(--accent); }
  .tabbody.browser iframe { flex: 1; border: 0; background: #fff; width: 100%; min-height: 0; }
  .tabbody.browser iframe[hidden] { display: none; }
  .tabbody.browser .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--dim); text-align: center; padding: 20px; gap: 8px; font-size: 13px; }
  .tabbody.browser .empty[hidden] { display: none; }
  .tabbody.browser .empty .urls { display: flex; flex-direction: column; gap: 4px; }
  .tabbody.term { background: #0a0c0d; }
  .tabbody.term .out { flex: 1; overflow-y: auto; margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.4; font-family: inherit; }
  .tabbody.term .out .l { min-height: 1.4em; }
  .tabbody.term .trow { display: flex; gap: 8px; padding: 6px 12px 8px; border-top: 1px solid var(--line); align-items: baseline; flex: none; }
  .tabbody.term .prompt { color: var(--accent); white-space: nowrap; max-width: 45%; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .tabbody.term input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; font-size: 12.5px; }
  .ab { font-weight: 700; } .ad { opacity: .6; }
  .a30 { color: #3b4048; } .a31 { color: var(--red); } .a32 { color: var(--green); } .a33 { color: var(--yellow); }
  .a34 { color: #7aa2f7; } .a35 { color: var(--magenta); } .a36 { color: var(--accent); } .a37 { color: #c0caf5; }
  .a90 { color: var(--gray); } .a91 { color: #ff9e9e; } .a92 { color: #b9f27c; } .a93 { color: #ffd580; }
  .a94 { color: #8db4ff; } .a95 { color: #d0b4ff; } .a96 { color: #74e0f0; } .a97 { color: #eef3f5; }

  /* Narrow windows: the sidebar floats over the chat instead of squeezing it,
     and the panel cannot take more than half the width. */
  @media (max-width: 1000px) {
    #side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 20; box-shadow: 8px 0 30px rgba(0,0,0,.5); }
    #main { padding-left: 0; }
    #sidetoggle { display: inline-flex; }
    #panel { max-width: 55vw; }
  }

  /* ---- folder picker ---- */
  #modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
  #modal[hidden] { display: none; }
  .dlg { width: min(680px, 92vw); max-height: 82vh; background: var(--box); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  .dlghdr { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 700; gap: 8px; }
  .pathrow { display: flex; gap: 6px; padding: 10px 14px 6px; }
  .pathrow input { flex: 1; background: var(--bg); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 4px; outline: 0; }
  .pathrow input:focus { border-color: var(--accent); }
  #fsroots { padding: 2px 14px 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { background: #1a2023; border: 1px solid var(--line); color: var(--dim); border-radius: 12px; padding: 1px 10px; font-size: 12px; cursor: pointer; }
  .chip:hover { color: var(--fg); border-color: var(--accent); }
  #fslist { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 240px; }
  .fsitem { padding: 4px 8px; border-radius: 4px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  .fsitem:hover { background: #1a2023; }
  .fsitem .proj { color: var(--accent); font-size: 11px; }
  .fsitem.up { color: var(--dim); }
  .dlgfoot { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--dim); }
  .dlgfoot label { display: flex; align-items: center; gap: 6px; cursor: pointer; }

  /* The working surface: quieter navigation and a single compact control row. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  #side { width: 248px; }
  .sidehdr { padding: 22px 18px 18px; }

  #openfolder { margin: 0 14px 20px; padding: 8px 10px; background: transparent; }
  .wshdr { padding: 8px; }
  .wsname { max-width: 78%; font-weight: 600; }
  .sess { padding: 8px 8px 8px 12px; border-radius: 6px; }
  .sess.active { background: #20292d; }
  .stitle.untitled { font-style: normal; }
  .stime { display: none; }
  .sess:hover .stime { display: inline; }
  .sidefoot { align-items: center; padding: 12px 18px; }
  #top { min-height: 60px; padding: 12px 20px; }
  #crumb .ws { font-weight: 500; color: var(--dim); }
  #crumb .title { color: var(--fg); font-weight: 600; }
  #logs, #busywrap { max-width: 860px; padding-left: 32px; padding-right: 32px; }
  #welcome { max-width: 660px; padding-top: clamp(48px, 16vh, 180px); }
  #welcome h1 { font-size: clamp(26px, 3vw, 38px); letter-spacing: -1.2px; font-weight: 500; margin: 16px 0 24px; }
  .primary { padding: 9px 18px; border-radius: 7px; }
  .recent-label { font-size: 12px; margin-top: 30px; margin-bottom: 6px; color: var(--gray); }
  .wsbtn { width: 100%; padding: 9px 0; }
  .wsbtn .dim { float: right; }
  /* A fresh session opens on the logo until the first message arrives. */
  .log:empty::before { content: "${LOGO_CSS}"; display: block; margin-top: 14vh; color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; line-height: 1.15; }
  .log:empty::after { content: "What are we building?"; display: block; margin-top: 18px; color: var(--dim); font-size: 26px; letter-spacing: -.7px; }
  .user { border: 1px solid var(--line); border-radius: 10px; background: #1b2125; padding: 14px 18px; margin: 24px 0; font-weight: 400; }
  .md { line-height: 1.8; }
  .md p { margin: 12px 0; }
  .md code, .md pre, .tool, .tabbody.term, .plan { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
  .tool { margin: 3px 0; border-radius: 5px; }
  .tool summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px; padding: 4px 0; list-style: none; }
  .tool summary::before { content: "›"; color: var(--gray); }
  .tool[open] summary::before { content: "⌄"; }
  .tool .name { color: var(--dim); font-weight: 400; white-space: nowrap; }
  .tool .tool-args { white-space: nowrap; text-overflow: ellipsis; overflow: hidden; color: var(--gray); }
  .tool.finished .name { color: #b9c6c7; }
  .tool.failed .name, .tool.failed summary::before { color: var(--red); }
  .result { margin: 4px 0 12px 16px; border: 1px solid var(--line); border-radius: 6px; background: #0e1214; padding: 12px; max-height: 280px; overflow: auto; white-space: pre-wrap; }
  .plan { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; background: transparent; line-height: 1.9; }
  .thought, .turnend { font-size: 12px; }
  .turnend { margin-top: 20px; margin-bottom: 20px; }
  #bottom { padding: 16px 32px 24px; }
  #bottom .inner { max-width: 796px; }
  #inputbox { border: 1px solid #354149; border-radius: 12px; padding: 14px 16px 10px; background: #1b2125; box-shadow: 0 8px 30px #0002; }
  #inputbox:focus-within { border-color: #55737b; }
  #input { min-height: 50px; line-height: 1.6; }
  #input::placeholder { color: var(--gray); }
  #actionbtn { border-radius: 6px; padding: 5px 12px; color: var(--fg); }
  #status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-top: 12px; }
  .statusbtn { background: transparent; color: var(--dim); border: 0; border-radius: 4px; cursor: pointer; padding: 3px 4px; font: inherit; }
  .statusbtn:hover { background: #293138; color: var(--fg); }
  .modelpick { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status .mode { font-weight: 500; }
  #status .eff { color: var(--dim); }
  .context-chip { display: flex; align-items: center; gap: 6px; }
  .context-chip.pressure { color: var(--yellow); }
  meter { width: 35px; height: 8px; appearance: none; border: none; background: #364047; border-radius: 9px; overflow: hidden; }
  meter::-webkit-meter-bar { background: #364047; border: none; }
  meter::-webkit-meter-optimum-value { background: #7dabad; }
  meter::-moz-meter-bar { background: #7dabad; }
  .task-chip, .plan-chip { white-space: nowrap; }
  #busywrap { padding-top: 8px; }
  #busy { font-size: 12px; }
  #panel { background: #101416; }
  .shortcut-list { line-height: 2; padding: 16px 24px; }

  /* Attachments: chips in the composer; thumbnails and file links in a sent message. */
  #attachrow { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .attach { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px 4px 8px; background: #141a1d; font-size: 12px; color: var(--fg); }
  .attach.uploading { opacity: .7; }
  .attach.warn { border-color: var(--yellow); }
  .attach-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
  .attach-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .note { color: var(--yellow); }
  .attach-x { background: transparent; border: 0; color: var(--dim); cursor: pointer; font: inherit; font-size: 15px; padding: 0 2px; line-height: 1; }
  .attach-x:hover { color: var(--red); }
  #attachbtn { flex: none; padding: 5px 7px; }
  #main.dragging #inputbox { border-color: var(--accent); box-shadow: 0 0 0 3px #35bfd433; }
  .user .files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .user .thumb { display: block; max-width: min(320px, 100%); max-height: 240px; border-radius: 8px; border: 1px solid var(--line); }
  .user .filechip { display: inline-block; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font-size: 12px; color: var(--fg); text-decoration: none; background: #141a1d; }
  .user .filechip:hover { border-color: var(--accent); }
  @media (max-width: 600px) {
    #top { min-height: 48px; padding: 8px 12px; }
    #logs, #busywrap { padding-left: 16px; padding-right: 16px; }
    #bottom { padding: 12px; }
    #welcome { padding: 48px 24px; }
    #panel { position: absolute; inset: 48px 0 0; width: 100% !important; max-width: 100%; z-index: 15; }
    .modelpick { max-width: 150px; }
    .wshdr .iconbtn, .sess .iconbtn { visibility: visible; }
  }
`;

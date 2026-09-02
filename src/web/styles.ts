// Stylesheet for the web page. One dark, monospace theme shared with the TUI.

export const STYLES = String.raw`
  :root {
    --bg: #0b0d0e; --fg: #d6dbde; --dim: #6b7480; --gray: #4a525c;
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
    font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
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
  .brand { font-weight: 700; color: var(--accent); letter-spacing: .5px; }
  .brand .coder { color: var(--dim); }
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
  #logwrap { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; }
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
  #logo { color: var(--accent); white-space: pre; font-size: 11px; line-height: 1.15; margin: 8px 0 12px; }
  #logo .coder { color: var(--dim); }

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
  .ask .opt .hint { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .ask > .hint { color: var(--dim); font-size: 12px; margin-top: 2px; }

  #bottom { flex: none; padding: 8px 16px 12px; background: var(--bg); }
  #bottom .inner { max-width: 920px; margin: 0 auto; position: relative; }
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
`;

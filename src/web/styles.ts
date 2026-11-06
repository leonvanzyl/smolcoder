// The web UI stylesheet: DESIGN.md's tokens (one set, a light and a dark
// column following prefers-color-scheme) and every non-sidebar component
// built from them. Components read only var(--…); only the token blocks
// differ by theme. The sidebar gets a basic token style here; its full design
// lives in sidebar-styles.ts, which loads after this sheet.

import { LOGO_ROWS } from "../logo";

// The logo as a CSS string: "\A " is a newline whose trailing space is eaten
// by the escape, so each row starts where it should.
const LOGO_CSS = LOGO_ROWS.map((r) => r.trimEnd()).join("\\A ");

/** Where the hub serves the bundled Inter Variable (see hub.ts FONT_ROUTE). */
const FONT_URL = "/fonts/inter-latin-wght-normal.woff2";

export const STYLES = String.raw`
  /* ---- font: self-hosted Inter Variable, Latin subset (SIL OFL 1.1) ---- */
  @font-face {
    font-family: "Inter Variable";
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
    src: local("Inter Variable"), local("InterVariable"), url("${FONT_URL}") format("woff2");
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
      U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191,
      U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }

  /* ---- tokens (DESIGN.md Quick Start) ---- */
  :root {
    color-scheme: light dark;

    --color-bg: #fcfcfc;
    --color-sidebar: #fafafa;
    --color-surface: #f4f4f5;
    --color-surface-raised: #ffffff;
    --color-surface-hover: #ededef;
    --color-sidebar-row-active: #ffffff;
    --color-sidebar-row-ring: #e4e4e7;
    --color-message: #ebebed;
    --color-border: #e4e4e7;
    --color-border-strong: #86868f;
    --color-text: #18181b;
    --color-text-muted: #696972;
    --color-accent: #1b4ed8;
    --color-accent-fill: #1b4ed8;
    --color-on-accent: #ffffff;
    --color-accent-soft: #e6ebf8;
    --color-info: #0069a8;
    --color-success: #007a55;
    --color-danger: #c10007;
    --color-warning: #ad4700;
    --color-diff-add-bg: #def4ed;
    --color-diff-remove-bg: #fce7e8;
    --color-focus-ring: #1b4ed8;
    --color-overlay: rgba(0, 0, 0, 0.32);

    --font-ui: -apple-system, BlinkMacSystemFont, "Inter Variable", "InterVariable",
      Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    --font-mono: "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas,
      "Liberation Mono", monospace;
    --text-display: 20px;
    --text-title: 16px;
    --text-body: 14px;
    --text-ui: 14px;
    --text-compact: 13px;
    --text-meta: 12px;
    --text-micro: 11px;
    --text-code: 13px;
    --text-code-inline: 0.85em;
    --leading-display: 1.4;
    --leading-title: 1.375;
    --leading-body: 1.625;
    --leading-ui: 1.43;
    --leading-compact: 1.4;
    --leading-meta: 1.33;
    --leading-code: 1.5;
    --tracking-display: -0.3px;
    --tracking-title: -0.1px;
    --weight-regular: 400;
    --weight-medium: 500;
    --weight-semibold: 600;

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;
    --space-12: 48px;

    --size-sidebar: 256px;
    --size-sidebar-min: 208px;
    --size-column: 736px;
    --size-topbar: 52px;
    --size-row: 28px;
    --size-hit: 32px;

    --radius-badge: 4px;
    --radius-row: 6px;
    --radius-control: 8px;
    --radius-card: 16px;
    --radius-hero: 20px;
    --radius-pill: 9999px;

    --shadow-none: none;
    --hairline: 1px solid var(--color-border);
    --shadow-popover: 0 16px 40px -18px rgba(0, 0, 0, 0.35);

    --motion-fast: 150ms;
    --motion-base: 200ms;
    --ease-out: cubic-bezier(0.2, 0, 0, 1);

    /* Layout estimates for rows that are off screen (content-visibility). */
    --row-estimate: 60px; --row-estimate-tool: 30px; --row-estimate-md: 160px;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #000000;
      --color-sidebar: #0a0a0a;
      --color-surface: #0a0a0a;
      --color-surface-raised: #111111;
      --color-surface-hover: #1a1a1b;
      --color-sidebar-row-active: #252527;
      --color-sidebar-row-ring: transparent;
      --color-message: #1e1e1e;
      --color-border: rgba(255, 255, 255, 0.08);
      --color-border-strong: #6b6b6b;
      --color-text: #f5f5f5;
      --color-text-muted: #a3a3a3;
      --color-accent: #51a2ff;
      --color-accent-fill: #346bf1;
      --color-on-accent: #ffffff;
      --color-accent-soft: #09132b;
      --color-info: #74d4ff;
      --color-success: #00d492;
      --color-danger: #ff6467;
      --color-warning: #ffb900;
      --color-diff-add-bg: #001e14;
      --color-diff-remove-bg: #2d080a;
      --color-focus-ring: #51a2ff;
      --color-overlay: rgba(0, 0, 0, 0.6);
      --shadow-popover: 0 18px 44px -18px rgba(0, 0, 0, 0.8);
    }
  }

  /* ---- base ---- */
  * { box-sizing: border-box; }
  /* Class rules below set display; the hidden attribute must still win. */
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  html { scrollbar-color: color-mix(in srgb, var(--color-text-muted) 35%, transparent) transparent; }
  * { scrollbar-width: thin; }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--color-text-muted) 35%, transparent); border-radius: var(--radius-pill); border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--color-text-muted) 60%, transparent); background-clip: padding-box; }
  body {
    margin: 0; display: flex; overflow: hidden;
    font-family: var(--font-ui); font-size: var(--text-ui); line-height: var(--leading-ui);
    color: var(--color-text); background: var(--color-bg);
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  button, input, textarea, select { font: inherit; color: inherit; }
  a { color: var(--color-accent); }
  kbd { font-family: var(--font-mono); }
  ::placeholder { color: var(--color-text-muted); opacity: 1; }
  ::selection { background: var(--color-accent-soft); color: var(--color-text); }
  .grow { flex: 1; }
  .hint { color: var(--color-text-muted); font-size: var(--text-meta); line-height: var(--leading-meta); }
  .dim { color: var(--color-text-muted); }

  :focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes grow-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  /* ---- buttons ---- */
  .primary, .ghost, .linkbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1);
    height: var(--size-hit); padding: 0 var(--space-3); border-radius: var(--radius-control);
    font-size: var(--text-ui); font-weight: var(--weight-medium); line-height: 1; cursor: pointer; white-space: nowrap;
    transition: background-color var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .primary { background: var(--color-accent-fill); color: var(--color-on-accent); border: 1px solid transparent; }
  .primary:hover { filter: brightness(.94); }
  .ghost { background: transparent; color: var(--color-text); border: 1px solid var(--color-border-strong); }
  .ghost:hover { background: var(--color-surface-hover); }
  .ghost.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .linkbtn { background: transparent; border: 1px solid transparent; color: var(--color-accent); padding: 0 var(--space-2); }
  .linkbtn:hover { background: var(--color-surface-hover); }
  .iconbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1);
    min-width: var(--size-row); height: var(--size-row); padding: 0 var(--space-1);
    background: transparent; border: 1px solid transparent; border-radius: var(--radius-control);
    color: var(--color-text-muted); cursor: pointer; line-height: 1; text-decoration: none; font-size: var(--text-compact);
    transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .iconbtn:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .iconbtn.on { background: var(--color-accent-soft); color: var(--color-accent); }
  .iconbtn svg { display: block; width: 16px; height: 16px; }
  button:disabled { opacity: .64; cursor: not-allowed; }

  /* ---- inputs ---- */
  .pathrow input, .tabbody.browser .bar input, .ask .askinput {
    height: var(--size-hit); padding: 0 10px; background: var(--color-surface-raised); color: var(--color-text);
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-control); font-size: var(--text-ui);
  }
  .pathrow input:focus, .tabbody.browser .bar input:focus, .ask .askinput:focus { border-color: var(--color-focus-ring); }

  /* ---- left sidebar (basic; sidebar-styles.ts owns the full design) ---- */
  #side { width: var(--size-sidebar); flex: none; background: var(--color-sidebar); border-right: var(--hairline); display: flex; flex-direction: column; min-height: 0; }
  #side.collapsed { display: none; }
  .sidehdr { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-4) var(--space-3) var(--space-3) var(--space-4); }
  /* The SMOL block logo, sized so all 39 columns fit beside the collapse button. */
  .brand { color: var(--color-accent); white-space: pre; font-family: var(--font-mono); font-size: 7px; line-height: 1.15; }
  #openfolder { margin: 0 var(--space-2) var(--space-2); justify-content: flex-start; height: var(--size-row); font-size: var(--text-compact); }
  #wslist { flex: 1; overflow-y: auto; padding: 0 var(--space-2) var(--space-3); }
  .sidehint { color: var(--color-text-muted); font-size: var(--text-meta); padding: var(--space-2) 10px; }
  #wslist .ws { margin-top: var(--space-2); }
  .wshdr { display: flex; align-items: center; gap: var(--space-1); height: var(--size-hit); padding: 0 var(--space-1) 0 10px; border-radius: var(--radius-row); color: var(--color-text-muted); font-size: var(--text-meta); }
  .wshdr:hover { background: var(--color-surface-hover); }
  .wsname { color: var(--color-text); font-size: var(--text-ui); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .wspath { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-micro); color: var(--color-text-muted); }
  .sessions { display: flex; flex-direction: column; gap: 2px; }
  .sess { display: flex; align-items: center; gap: var(--space-2); height: var(--size-hit); padding: 0 var(--space-1) 0 10px; border-radius: var(--radius-row); cursor: pointer; color: var(--color-text); font-size: var(--text-ui); }
  .sess:hover { background: var(--color-surface-hover); }
  .sess.active { background: var(--color-sidebar-row-active); box-shadow: inset 0 0 0 1px var(--color-border); }
  .sess.stored { color: var(--color-text-muted); }
  .sess.stored:hover { color: var(--color-text); }
  .sess .dot { width: 6px; height: 6px; border-radius: 50%; background: transparent; flex: none; }
  .sess.busy .dot, .sess.starting .dot { background: var(--color-info); animation: pulse 2s infinite; }
  .sess.waiting .dot { background: var(--color-warning); }
  .sess.error .dot { background: var(--color-danger); }
  .sess.unread .dot { background: var(--color-success); }
  .sess.unread .stitle { font-weight: var(--weight-medium); }
  .stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stitle.renaming { background: var(--color-surface-raised); color: var(--color-text); border: 1px solid var(--color-border-strong); border-radius: var(--radius-badge); padding: 1px 6px; font-size: var(--text-ui); font-weight: var(--weight-medium); }
  .stitle.renaming:focus { border-color: var(--color-focus-ring); }
  .stime { font-size: var(--text-meta); color: var(--color-text-muted); flex: none; font-variant-numeric: tabular-nums; }
  .wshdr .iconbtn, .sess .iconbtn { width: 24px; min-width: 24px; height: 24px; opacity: 0; }
  .wshdr:hover .iconbtn, .wshdr:focus-within .iconbtn, .sess:hover .iconbtn, .sess:focus-within .iconbtn { opacity: 1; }
  .sess:hover .stime, .sess:focus-within .stime { display: none; }
  .sess:focus-visible, .wshdr:focus-visible { outline-offset: -2px; }
  .sidefoot { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4); font-size: var(--text-micro); color: var(--color-text-muted); border-top: var(--hairline); }

  /* ---- main column ---- */
  #main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  #top { display: flex; align-items: center; gap: var(--space-2); height: var(--size-topbar); flex: none; padding: 0 var(--space-3) 0 var(--space-4); border-bottom: var(--hairline); background: var(--color-bg); font-size: var(--text-ui); color: var(--color-text-muted); }
  #top .iconbtn { min-width: var(--size-hit); height: var(--size-hit); }
  #crumb { flex: 1; min-width: 0; display: flex; align-items: center; overflow: hidden; white-space: nowrap; }
  #crumb .ws { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-muted); }
  #crumb .sep { flex: none; margin: 0 var(--space-2); color: var(--color-text-muted); opacity: .7; }
  #crumb .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--color-text); font-weight: var(--weight-medium); }
  /* The session's checkout: branch glyph, name, and uncommitted +N −M. */
  .crumb-git { flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 6px; height: 24px; margin-inline-start: var(--space-3); padding: 0 var(--space-2); border: var(--hairline); border-radius: var(--radius-pill); color: var(--color-text-muted); font-size: var(--text-meta); }
  .crumb-git .sb-glyph svg { width: 12px; height: 12px; display: block; }
  .crumb-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); }
  .crumb-git .sb-diff { flex: none; display: inline-flex; gap: 4px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .crumb-git .add { color: var(--color-success); }
  .crumb-git .del { color: var(--color-danger); }
  #crumb .model { color: var(--color-text-muted); margin-left: var(--space-3); }
  #logwrap { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; overflow-anchor: none; }
  #logs, #busywrap { max-width: calc(var(--size-column) + 2 * var(--space-8)); margin: 0 auto; padding: var(--space-6) var(--space-8) 0; }
  #logs { overflow-wrap: anywhere; }
  #wslist, #fslist, .tabbody.term .out { overflow-x: hidden; }
  #busywrap { padding-top: var(--space-1); padding-bottom: var(--space-5); }

  /* ---- empty states: the welcome column and a fresh session (SMOL logo) ---- */
  #welcome { max-width: 512px; margin: 0 auto; padding: clamp(48px, 14vh, 160px) var(--space-8) var(--space-12); text-align: center; }
  #logo { display: table; margin: 0 auto var(--space-6); text-align: start; color: var(--color-accent); white-space: pre; font-family: var(--font-mono); font-size: 11px; line-height: 1.15; }
  #logo .coder { color: var(--color-text-muted); }
  #welcome h1 { margin: 0 0 var(--space-2); font-size: var(--text-display); line-height: var(--leading-display); letter-spacing: var(--tracking-display); font-weight: var(--weight-semibold); color: var(--color-text); }
  #welcome p { margin: 0; color: var(--color-text-muted); font-size: var(--text-body); }
  #welcome .row { display: flex; justify-content: center; gap: var(--space-2); margin: var(--space-6) 0 var(--space-8); }
  #recent { display: flex; flex-direction: column; gap: 2px; text-align: start; }
  .recent-label { font-size: var(--text-meta); font-weight: var(--weight-medium); color: var(--color-text-muted); padding: 0 10px var(--space-1); }
  .wsbtn { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); width: 100%; height: var(--size-hit); padding: 0 10px; background: transparent; border: 0; border-radius: var(--radius-row); color: var(--color-text); cursor: pointer; text-align: start; font-size: var(--text-ui); }
  .wsbtn:hover { background: var(--color-surface-hover); }
  .wsbtn > span:first-child { font-weight: var(--weight-medium); white-space: nowrap; }
  .wsbtn .dim { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--text-meta); color: var(--color-text-muted); }
  /* A fresh session opens on the logo and the question until its first user
     or assistant message (client.ts drops .fresh then). Notes that arrive
     first, such as a model warning, sit centred below them: the flex order
     puts both pseudo-elements ahead of the notes. */
  .log.fresh { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding-top: clamp(32px, 12vh, 140px); }
  .log.fresh::before { order: -2; content: "${LOGO_CSS}"; display: block; text-align: start; color: var(--color-accent); white-space: pre; font-family: var(--font-mono); font-size: 11px; line-height: 1.15; }
  .log.fresh::after { order: -1; content: "What should we work on?"; display: block; margin: var(--space-4) 0 var(--space-4); text-align: center; color: var(--color-text); font-size: var(--text-display); line-height: var(--leading-display); letter-spacing: var(--tracking-display); font-weight: var(--weight-semibold); }
  .log.fresh > * { align-self: stretch; }
  .log.fresh > .line-status, .log.fresh > .line-warn, .log.fresh > .line-error { align-self: center; max-width: 100%; text-align: center; }
  .log.fresh[hidden] { display: none; }
  /* ...and the busy line ("loading the model…") centres under them. */
  #logwrap:has(.log.fresh:not([hidden])) #busy { text-align: center; }

  /* ---- user message ---- */
  .user { width: fit-content; max-width: 80%; margin: var(--space-6) 0 var(--space-6) auto; padding: 10px var(--space-4); background: var(--color-message); color: var(--color-text); border-radius: var(--radius-card); font-size: var(--text-body); line-height: var(--leading-body); white-space: pre-wrap; }
  .log > .user:first-child { margin-top: 0; }
  .user .files { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
  .user .thumb { display: block; max-width: min(320px, 100%); max-height: 240px; border-radius: var(--radius-control); border: var(--hairline); }
  .user .filechip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border: var(--hairline); border-radius: var(--radius-pill); background: var(--color-surface-raised); color: var(--color-text); text-decoration: none; font-size: var(--text-meta); }
  .user .filechip:hover { border-color: var(--color-border-strong); }

  /* ---- assistant prose (markdown) ---- */
  .md { position: relative; white-space: normal; margin: var(--space-2) 0; font-size: var(--text-body); line-height: var(--leading-body); color: var(--color-text); }
  .md p { margin: var(--space-3) 0; }
  .md > :first-child, .md > .msgcopy + * { margin-top: 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 20px 0 var(--space-2); line-height: var(--leading-title); font-weight: var(--weight-semibold); color: var(--color-text); }
  .md h1 { font-size: 16px; letter-spacing: var(--tracking-title); } .md h2 { font-size: 15px; } .md h3 { font-size: 14px; }
  .md h4, .md h5, .md h6 { font-size: 14px; }
  .md ul, .md ol { margin: var(--space-3) 0; padding-inline-start: 22px; }
  .md li { margin: var(--space-1) 0; }
  .md strong { font-weight: var(--weight-semibold); }
  .md a { color: var(--color-accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .md code { background: var(--color-surface); padding: .1em .35em; border-radius: var(--radius-badge); font-family: var(--font-mono); font-size: var(--text-code-inline); color: var(--color-text); }
  .md pre { margin: var(--space-3) 0; padding: 10px var(--space-3); overflow-x: auto; background: var(--color-surface); border: var(--hairline); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--text-code); line-height: var(--leading-code); }
  .md pre code { background: none; padding: 0; font-size: inherit; }
  .md table { border-collapse: collapse; margin: var(--space-3) 0; display: block; overflow-x: auto; max-width: 100%; font-size: var(--text-compact); line-height: var(--leading-compact); }
  .md th, .md td { border: var(--hairline); padding: 6px 10px; text-align: start; }
  .md th { background: var(--color-surface); font-weight: var(--weight-semibold); }
  .md blockquote { border-inline-start: 2px solid var(--color-border-strong); margin: var(--space-3) 0; padding-inline-start: var(--space-3); color: var(--color-text-muted); }
  /* Hebrew, Arabic: the client sets dir on blocks by majority; free text
     (thoughts, titles) takes each line's first letter. Code stays LTR. */
  .thought-body, .stitle, #crumb .title { unicode-bidi: plaintext; text-align: start; }
  .md code { unicode-bidi: plaintext; }
  .md hr { border: 0; border-top: var(--hairline); margin: var(--space-4) 0; }

  /* ---- code blocks: language label + copy ---- */
  .md .codeblock { margin: var(--space-3) 0; border: var(--hairline); border-radius: var(--radius-control); background: var(--color-surface); overflow: hidden; }
  .md .codeblock pre { margin: 0; border: 0; border-radius: 0; background: transparent; }
  .codehead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); height: 28px; padding: 0 var(--space-1) 0 var(--space-3); border-bottom: var(--hairline); }
  .codehead .lang { font-size: var(--text-meta); color: var(--color-text-muted); text-transform: lowercase; }
  .copybtn, .msgcopy { display: inline-flex; align-items: center; height: 22px; padding: 0 var(--space-2); background: transparent; color: var(--color-text-muted); border: 0; border-radius: var(--radius-badge); cursor: pointer; font-size: var(--text-meta); line-height: 1; transition: opacity var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out); }
  .copybtn:hover, .msgcopy:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .copybtn.done { color: var(--color-success); }
  .copybtn.done::before { content: "✓"; margin-inline-end: var(--space-1); }
  .msgcopy { position: absolute; top: 0; inset-inline-end: 0; z-index: 1; background: var(--color-surface-raised); border: var(--hairline); }
  /* Mouse users see the copy controls on hover; touch and keyboard always. */
  @media (hover: hover) {
    .codeblock .copybtn, .msgcopy { opacity: 0; }
    .codeblock:hover .copybtn, .copybtn:focus-visible, .copybtn.done, .md:hover > .msgcopy, .msgcopy:focus-visible { opacity: 1; }
  }

  /* ---- reasoning disclosure ---- */
  .thought { margin: var(--space-1) 0; color: var(--color-text-muted); font-size: var(--text-meta); line-height: var(--leading-meta); }
  .thought summary { display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-row); padding: 0 var(--space-2); cursor: pointer; list-style: none; border-radius: var(--radius-row); }
  .thought summary::-webkit-details-marker { display: none; }
  .thought summary::before { content: "›"; flex: none; width: 14px; text-align: center; font-size: 14px; transition: transform var(--motion-fast) var(--ease-out); }
  .thought[open] summary::before { transform: rotate(90deg); }
  .thought summary:hover { color: var(--color-text); }
  .thought-preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thought-preview::first-letter { text-transform: uppercase; }
  .thought.live .thought-preview::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-inline-end: 6px; vertical-align: 1px; border-radius: 50%; background: var(--color-info); animation: pulse 2s infinite; }
  .thought-expand, .thought-collapse { flex: none; font-size: var(--text-micro); opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
  .thought summary:hover .thought-expand, .thought summary:hover .thought-collapse, .thought summary:focus-visible .thought-expand, .thought summary:focus-visible .thought-collapse { opacity: 1; }
  .thought-collapse, .thought[open] .thought-expand { display: none; }
  .thought[open] .thought-collapse { display: inline; }
  .thought-body { color: var(--color-text-muted); font-size: var(--text-compact); line-height: var(--leading-body); white-space: pre-wrap; overflow-wrap: anywhere; border-inline-start: 2px solid var(--color-border); padding: var(--space-1) 0 var(--space-1) var(--space-3); margin: var(--space-1) 0 var(--space-3) 15px; max-height: 320px; overflow-y: auto; }

  /* ---- tool rows ---- */
  .tool { margin: 2px 0; font-size: var(--text-compact); line-height: var(--leading-compact); color: var(--color-text); }
  .tool > summary, .tool.argsrow { display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-row); padding: 0 var(--space-2); border-radius: var(--radius-row); }
  .tool > summary { cursor: pointer; list-style: none; transition: background-color var(--motion-fast) var(--ease-out); }
  .tool > summary::-webkit-details-marker { display: none; }
  .tool > summary:hover { background: var(--color-surface-hover); }
  /* Status glyph: a pulsing dot while running, then ✓ or ✗ (with a spoken label). */
  .tool > summary::before, .tool.argsrow::before { content: ""; flex: none; width: 14px; text-align: center; font-size: var(--text-compact); }
  .tool.running > summary::before, .tool.argsrow::before { content: "" / "running"; width: 6px; height: 6px; margin: 0 4px; border-radius: 50%; background: var(--color-info); animation: pulse 2s infinite; }
  .tool.finished > summary::before { content: "✓" / "done"; color: var(--color-success); }
  .tool.failed > summary::before { content: "✗" / "failed"; color: var(--color-danger); }
  /* Disclosure chevron at the end of the row. */
  .tool > summary::after { content: "›"; flex: none; width: 12px; text-align: center; color: var(--color-text-muted); font-size: 14px; transition: transform var(--motion-fast) var(--ease-out); }
  .tool[open] > summary::after { transform: rotate(90deg); }
  .tool .name { flex: none; color: var(--color-text); font-weight: var(--weight-medium); white-space: nowrap; }
  .tool .tool-args { flex: 1 1 0; min-width: 0; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--text-meta); }
  .tool .tool-meta { display: inline-flex; align-items: center; gap: var(--space-2); flex: none; color: var(--color-text-muted); font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
  .tool .tool-meta:empty { display: none; }
  .diffstat { display: inline-flex; gap: var(--space-1); font-family: var(--font-mono); font-weight: var(--weight-medium); }
  .diffstat .add { color: var(--color-success); }
  .diffstat .del { color: var(--color-danger); }
  .tool.argsrow .name { color: var(--color-text-muted); }
  /* "Explored · 3 reads, 2 searches": consecutive lookups in one row. */
  .tool.explore > summary .name { color: var(--color-text-muted); font-weight: var(--weight-regular); }
  .tool.explore > summary .tool-args { font-family: var(--font-ui); font-size: var(--text-compact); }
  .tool.explore > summary .tool-args::before { content: "· "; }
  .tool.explore .group-body { margin-inline-start: var(--space-4); }
  .result { margin: var(--space-1) 0 var(--space-2) var(--space-5); padding: 10px var(--space-3); max-height: 280px; overflow: auto; white-space: pre-wrap; background: var(--color-surface); border: var(--hairline); border-radius: var(--radius-control); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-code); line-height: var(--leading-code); }
  .result.err { border-inline-start: 2px solid var(--color-danger); }

  /* ---- diff blocks ---- */
  .diff { margin: var(--space-1) 0 var(--space-2) var(--space-5); max-height: 420px; overflow: auto; background: var(--color-surface); border: var(--hairline); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--text-code); line-height: 20px; color: var(--color-text); }
  .dl { display: flex; min-width: max-content; white-space: pre; }
  .dl .dm { flex: none; width: 20px; text-align: center; color: var(--color-text-muted); user-select: none; }
  .dl .dt { padding-inline-end: var(--space-3); }
  .dl.add { background: var(--color-diff-add-bg); }
  .dl.add .dm { color: var(--color-success); }
  .dl.del { background: var(--color-diff-remove-bg); }
  .dl.del .dm { color: var(--color-danger); }
  .dl.skip { background: var(--color-surface-hover); color: var(--color-text-muted); padding: 0 var(--space-2); min-width: 0; }
  .dl.skip .dm { width: 12px; }

  /* ---- plan card ---- */
  .plan { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: var(--hairline); border-radius: var(--radius-card); background: transparent; font-size: var(--text-compact); line-height: 1.8; }
  .plan .hdr { font-size: var(--text-ui); font-weight: var(--weight-semibold); margin-bottom: var(--space-1); }
  .plan .hdr small { color: var(--color-text-muted); font-weight: var(--weight-regular); font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
  .plan .mk { display: inline-block; width: 18px; }
  .plan .done { color: var(--color-text-muted); text-decoration: line-through; }
  .plan .done .mk { color: var(--color-success); text-decoration: none; }
  .plan .cur { color: var(--color-text); font-weight: var(--weight-medium); }
  .plan .todo { color: var(--color-text-muted); }

  /* ---- status lines ---- */
  .turnend { margin: var(--space-4) 0 var(--space-6); padding-top: var(--space-2); border-top: var(--hairline); color: var(--color-text-muted); font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
  .line-status { color: var(--color-text-muted); font-size: var(--text-compact); white-space: pre-wrap; }
  .line-warn { color: var(--color-warning); font-size: var(--text-compact); white-space: pre-wrap; }
  .line-error { color: var(--color-danger); font-size: var(--text-compact); white-space: pre-wrap; user-select: text; }
  .line-warn::before { content: "! "; font-weight: var(--weight-semibold); }
  .line-error::before { content: "✗ "; }
  #busy { color: var(--color-text-muted); font-size: var(--text-compact); display: none; padding-inline-start: var(--space-2); }
  #busy.on { display: block; }
  /* The braille spinner glyph becomes the shared pulsing status dot. */
  #busy .spin { display: inline-block; width: 6px; height: 6px; margin: 0 8px 0 4px; vertical-align: 1px; overflow: hidden; color: transparent; border-radius: 50%; background: var(--color-info); animation: pulse 2s infinite; }
  #busysecs { font-variant-numeric: tabular-nums; }

  /* ---- approval / question box ---- */
  .ask { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); background: var(--color-surface-raised); border: var(--hairline); border-inline-start: 2px solid var(--color-warning); border-radius: var(--radius-card); font-size: var(--text-ui); }
  .ask .asktitle, .ask > .cmd:first-child { font-weight: var(--weight-semibold); margin-bottom: var(--space-2); }
  .ask .cmd.code { margin: 0 0 var(--space-2); padding: var(--space-2) var(--space-3); background: var(--color-surface); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--text-code); line-height: var(--leading-code); white-space: pre-wrap; overflow-wrap: anywhere; font-weight: var(--weight-regular); }
  .ask > .hint { margin: 0 0 var(--space-2); }
  .ask > button { margin: var(--space-2) var(--space-2) 0 0; }
  .ask > button:not(.primary):not(.ghost):not(.linkbtn) { height: var(--size-hit); padding: 0 var(--space-3); background: transparent; color: var(--color-text); border: 1px solid var(--color-border-strong); border-radius: var(--radius-control); cursor: pointer; font-weight: var(--weight-medium); }
  .ask .askinput { margin-top: var(--space-1); width: min(420px, 100%); }
  .ask-rows { display: flex; flex-direction: column; gap: 2px; margin: 0 calc(-1 * var(--space-2)); }
  .ask-row { display: flex; align-items: center; gap: 2px; }
  .ask .opt { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-hit); padding: 0 var(--space-2); background: transparent; border: 0; border-radius: var(--radius-row); color: var(--color-text); cursor: pointer; text-align: start; font-size: var(--text-ui); }
  .ask .opt:hover { background: var(--color-surface-hover); }
  .ask .opt.current { color: var(--color-success); font-weight: var(--weight-medium); }
  .ask .opt .hint { margin-inline-start: auto; }
  .ask-group, #menu .mgroup, .chooser-group { padding: var(--space-2) var(--space-3) var(--space-1); font-size: var(--text-meta); font-weight: var(--weight-medium); color: var(--color-text-muted); }
  .ask .ask-group { padding-inline-start: var(--space-2); }

  /* ---- stars (pickers, palette, select boxes) ---- */
  .star { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; background: transparent; border: 0; border-radius: var(--radius-control); color: var(--color-text-muted); cursor: pointer; line-height: 1; padding: 0; }
  button.star:hover { background: var(--color-surface-hover); }
  .star.on { color: var(--color-warning); }

  /* ---- composer ---- */
  #bottom { flex: none; padding: 0 var(--space-8) var(--space-4); background: var(--color-bg); }
  #bottom .inner { max-width: var(--size-column); margin: 0 auto; position: relative; }
  #inputbox {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center;
    grid-template-areas: "attach attach attach" "input input input" "status clip send";
    padding: var(--space-3) var(--space-3) var(--space-2) var(--space-4); background: var(--color-surface-raised);
    border: var(--hairline); border-radius: var(--radius-card);
    transition: border-color var(--motion-fast) var(--ease-out);
  }
  #inputbox:hover { border-color: var(--color-border-strong); }
  #inputbox:focus-within { border-color: var(--color-focus-ring); }
  #main.dragging #inputbox { border-color: var(--color-accent); }
  .inputrow { display: contents; }
  #attachrow { grid-area: attach; display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
  #input { grid-area: input; width: 100%; min-height: 46px; padding: 0 var(--space-1) 0 0; background: transparent; border: 0; outline: 0; resize: none; color: var(--color-text); font-size: var(--text-body); line-height: var(--leading-body); }
  #input:focus-visible { outline: none; }
  #attachbtn { grid-area: clip; margin-inline-end: var(--space-1); }
  #actionbtn { grid-area: send; display: inline-flex; align-items: center; justify-content: center; width: var(--size-hit); height: var(--size-hit); padding: 0; border-radius: var(--radius-pill); background: var(--color-accent-fill); color: var(--color-on-accent); border: 1px solid transparent; cursor: pointer; transition: filter var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out); }
  #actionbtn:hover { filter: brightness(.94); }
  #actionbtn svg { display: block; width: 16px; height: 16px; }
  #actionbtn.stop { background: transparent; color: var(--color-danger); border-color: var(--color-danger); }
  #actionbtn.stop:hover { filter: none; background: var(--color-surface-hover); }
  #status { grid-area: status; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; margin: var(--space-1) 0 0 calc(-1 * var(--space-2)); font-size: var(--text-compact); line-height: var(--leading-compact); color: var(--color-text-muted); }
  .statusbtn { display: inline-flex; align-items: center; gap: 6px; height: var(--size-row); padding: 0 var(--space-2); background: transparent; color: var(--color-text-muted); border: 0; border-radius: var(--radius-control); cursor: pointer; font-size: var(--text-compact); white-space: nowrap; transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .statusbtn:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .modelpick { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
  #status .mode { font-weight: var(--weight-medium); }
  #status .mode.edit { color: var(--color-text); }
  #status .mode.ro { color: var(--color-text-muted); }
  #status .mode.bypass { color: var(--color-danger); }
  #status .eff { color: var(--color-text-muted); }
  .context-chip { font-variant-numeric: tabular-nums; }
  .context-chip.pressure { color: var(--color-warning); }
  .context-chip.critical { color: var(--color-danger); }
  meter { width: 40px; height: 6px; appearance: none; -webkit-appearance: none; border: none; background: var(--color-border); border-radius: var(--radius-pill); overflow: hidden; }
  meter::-webkit-meter-bar { background: var(--color-border); border: none; border-radius: var(--radius-pill); height: 6px; }
  meter::-webkit-meter-optimum-value, meter::-webkit-meter-suboptimum-value, meter::-webkit-meter-even-less-good-value { background: var(--color-text-muted); border-radius: var(--radius-pill); }
  meter::-moz-meter-bar { background: var(--color-text-muted); }
  .context-chip.pressure meter::-webkit-meter-optimum-value { background: var(--color-warning); }
  .context-chip.pressure meter::-moz-meter-bar { background: var(--color-warning); }
  .context-chip.critical meter::-webkit-meter-optimum-value { background: var(--color-danger); }
  .context-chip.critical meter::-moz-meter-bar { background: var(--color-danger); }
  .task-chip, .plan-chip { white-space: nowrap; padding: 0 var(--space-2); font-variant-numeric: tabular-nums; }
  #status .plan-chip.done { color: var(--color-success); }
  #status .line-warn { padding: 0 var(--space-2); }
  #hintrow { font-size: var(--text-meta); color: var(--color-text-muted); margin-top: var(--space-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- attachments in the composer ---- */
  .attach { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 32px; padding: 0 var(--space-1) 0 var(--space-1); border: var(--hairline); border-radius: var(--radius-pill); background: var(--color-surface); font-size: var(--text-meta); color: var(--color-text); }
  .attach:not(:has(.attach-thumb)) { padding-inline-start: var(--space-3); }
  .attach.uploading { opacity: .64; }
  .attach.warn { border-color: var(--color-warning); }
  .attach-thumb { width: 24px; height: 24px; object-fit: cover; border-radius: var(--radius-pill); }
  .attach-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .note { color: var(--color-warning); }
  .attach-x { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex: none; background: transparent; border: 0; border-radius: var(--radius-pill); color: var(--color-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
  .attach-x:hover { background: var(--color-surface-hover); color: var(--color-text); }

  /* ---- queued messages: chips stacked above the composer ---- */
  #queuerow { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-1); margin-bottom: var(--space-1); }
  .queue-label { display: none; }
  /* Paused after Stop: a one-line head says so, with Resume and Clear. */
  .queue-head { display: flex; align-items: center; gap: var(--space-1); min-height: var(--size-row); padding: 0 var(--space-1) 0 var(--space-3); font-size: var(--text-meta); }
  .queue-head .queue-label { display: inline; color: var(--color-text-muted); font-weight: var(--weight-medium); }
  .queue-head .grow { flex: 1; }
  .queue-head .linkbtn { height: 24px; font-size: var(--text-meta); }
  #queuerow.paused .qchip { color: var(--color-text-muted); }
  .qchip { display: flex; align-items: center; gap: var(--space-2); min-height: 28px; padding: 0 var(--space-1) 0 var(--space-3); background: var(--color-surface); border: var(--hairline); border-radius: var(--radius-pill); color: var(--color-text); font-size: var(--text-compact); animation: rise var(--motion-fast) var(--ease-out); }
  .qchip::before { content: "Queued"; flex: none; color: var(--color-text-muted); font-size: var(--text-meta); }
  .qchip ~ .qchip { color: var(--color-text-muted); }
  .qchip.sending { opacity: .64; }
  .qchip .qtext { flex: 0 1 auto; max-width: 60ch; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qchip .dim { font-size: var(--text-meta); }
  .qchip .attach-x { margin-inline-start: auto; }

  /* ---- jump to latest ---- */
  #jumpbottom { position: absolute; bottom: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%); z-index: 4; height: 28px; padding: 0 var(--space-3); background: var(--color-surface-raised); color: var(--color-text); border: var(--hairline); border-radius: var(--radius-pill); box-shadow: var(--shadow-popover); font-size: var(--text-compact); font-weight: var(--weight-regular); animation: fade-in var(--motion-fast) var(--ease-out); }
  #jumpbottom:hover { background: var(--color-surface-hover); }

  /* ---- popover chrome: slash and @ menus, status-bar pickers, palette ---- */
  #menu, .chooser { background: var(--color-surface-raised); color: var(--color-text); border: var(--hairline); border-radius: var(--radius-control); box-shadow: var(--shadow-popover); }
  #menu { position: absolute; bottom: calc(100% + var(--space-2)); left: 0; right: 0; display: none; z-index: 5; max-height: 320px; overflow-y: auto; padding: var(--space-1); animation: rise var(--motion-base) var(--ease-out); }
  #menu .item { display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-hit); padding: 0 var(--space-2); border-radius: var(--radius-row); cursor: pointer; }
  #menu .item .nm { font-size: var(--text-ui); font-weight: var(--weight-medium); white-space: nowrap; }
  #menu .item .ds { flex: 1; min-width: 0; color: var(--color-text-muted); font-size: var(--text-compact); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #menu .item.sel { background: var(--color-accent-soft); }
  #menu .item.sel .ds { color: var(--color-text); }
  #menu .item.inert { cursor: default; color: var(--color-text-muted); }
  #menu .mgroup { padding-inline-start: var(--space-2); }
  .mkey, .chooser-key { flex: none; padding: 1px 5px; font-family: var(--font-mono); font-size: var(--text-micro); line-height: 1.45; color: var(--color-text-muted); background: var(--color-surface); border: var(--hairline); border-radius: var(--radius-badge); margin-inline-start: auto; }
  .sel .mkey, .sel .chooser-key { color: var(--color-text); }

  .chooser { display: flex; flex-direction: column; overflow: hidden; font-size: var(--text-ui); }
  .chooser.popover { position: fixed; z-index: 60; min-width: 260px; max-height: min(60vh, 420px); animation: rise var(--motion-base) var(--ease-out); }
  .chooser-title { padding: var(--space-2) var(--space-3) 0; font-size: var(--text-meta); font-weight: var(--weight-medium); color: var(--color-text-muted); }
  .chooser-filter { flex: none; height: 36px; margin: 0; padding: 0 var(--space-3); background: transparent; color: var(--color-text); border: 0; border-bottom: var(--hairline); border-radius: 0; font-size: var(--text-ui); outline: 0; }
  /* The field holds focus for as long as its popover is open (the rows are
     not focusable), so the caret is the focus cue; no ring inside the card. */
  .chooser-filter:focus-visible { outline: none; }
  .chooser-list { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-1); }
  .chooser-group { position: sticky; top: calc(-1 * var(--space-1)); z-index: 1; background: var(--color-surface-raised); }
  .chooser-row { display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-hit); padding: 0 var(--space-2); border-radius: var(--radius-row); cursor: pointer; }
  .chooser-row.sel { background: var(--color-accent-soft); }
  .chooser-row.current .chooser-label { color: var(--color-accent); }
  .chooser-label { flex: none; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chooser-hint { flex: 1; min-width: 0; color: var(--color-text-muted); font-size: var(--text-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: end; }
  .chooser-row.sel .chooser-hint { color: var(--color-text); }
  .chooser-empty { padding: var(--space-3); color: var(--color-text-muted); }
  .chooser-foot { flex: none; padding: var(--space-2) var(--space-3); border-top: var(--hairline); font-size: var(--text-meta); color: var(--color-text-muted); }
  .palette-backdrop { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: center; align-items: flex-start; padding-top: 15vh; background: var(--color-overlay); animation: fade-in var(--motion-base) var(--ease-out); }
  .chooser.palette { width: min(560px, 92vw); max-height: 70vh; border-radius: var(--radius-card); animation: grow-in var(--motion-base) var(--ease-out); }
  .chooser.palette .chooser-filter { height: 48px; padding: 0 var(--space-4); font-size: var(--text-title); }
  .chooser.palette .chooser-list { padding: var(--space-2); }

  /* ---- toasts ---- */
  /* Bottom centre, clear of the composer card. */
  #toasts { position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%); z-index: 80; display: flex; flex-direction: column; align-items: center; gap: var(--space-2); width: max-content; max-width: min(420px, calc(100vw - 2 * var(--space-4))); }
  .toast { display: flex; align-items: center; gap: var(--space-2); max-width: 100%; padding: 10px 14px; background: var(--color-surface-raised); color: var(--color-text); border: var(--hairline); border-radius: var(--radius-control); box-shadow: var(--shadow-popover); font-size: var(--text-compact); line-height: var(--leading-compact); animation: rise var(--motion-base) var(--ease-out); }
  .toast.success::before { content: "✓"; color: var(--color-success); flex: none; }
  .toast.error::before { content: "✗"; color: var(--color-danger); flex: none; }
  .toast.warn::before { content: "!"; color: var(--color-warning); font-weight: var(--weight-semibold); flex: none; width: 10px; text-align: center; }
  .toast-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .toast-action { flex: none; background: transparent; color: var(--color-accent); border: 0; border-radius: var(--radius-badge); padding: 2px var(--space-1); cursor: pointer; font-weight: var(--weight-medium); }
  .toast-action:hover { text-decoration: underline; text-underline-offset: 2px; }
  .toast-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; background: transparent; border: 0; border-radius: var(--radius-badge); color: var(--color-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0; opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
  .toast:hover .toast-x, .toast:focus-within .toast-x { opacity: 1; }
  .toast-x:hover { color: var(--color-text); background: var(--color-surface-hover); }

  /* ---- the update popover, over the sidebar footer ---- */
  .upd-pop { position: fixed; z-index: 70; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); background: var(--color-surface-raised); color: var(--color-text); border: var(--hairline); border-radius: var(--radius-card); box-shadow: var(--shadow-popover); font-size: var(--text-compact); line-height: var(--leading-compact); outline: 0; animation: rise var(--motion-base) var(--ease-out); }
  .upd-hdr { display: flex; align-items: center; gap: var(--space-2); margin: -6px -8px -6px 0; }
  .upd-title { flex: 1; min-width: 0; font-size: var(--text-ui); font-weight: var(--weight-semibold); }
  .upd-x { font-size: 18px; }
  .upd-vers { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-title); line-height: var(--leading-title); font-weight: var(--weight-medium); letter-spacing: var(--tracking-title); font-variant-numeric: tabular-nums; }
  .upd-cur, .upd-arrow { color: var(--color-text-muted); }
  .upd-note { font-size: var(--text-meta); font-weight: var(--weight-regular); color: var(--color-text-muted); letter-spacing: 0; }
  .upd-link { display: inline-flex; align-items: center; gap: var(--space-1); align-self: flex-start; color: var(--color-accent); font-weight: var(--weight-medium); text-decoration: none; }
  .upd-link:hover { text-decoration: underline; text-underline-offset: 2px; }
  .upd-link svg { display: block; }
  .upd-meta { font-size: var(--text-meta); line-height: var(--leading-meta); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .upd-log { margin: 0; max-height: 132px; overflow: auto; padding: var(--space-2) var(--space-3); background: var(--color-surface); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--text-micro); line-height: 1.5; color: var(--color-text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  .upd-msg { display: flex; flex-direction: column; gap: var(--space-2); }
  .upd-msg.err .upd-msgline { color: var(--color-danger); }
  .upd-msgsub { font-size: var(--text-meta); color: var(--color-text-muted); }
  .upd-code { display: flex; align-items: center; gap: var(--space-2); padding: 4px 4px 4px var(--space-3); background: var(--color-surface); border-radius: var(--radius-control); }
  .upd-code code { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--text-meta); overflow-wrap: anywhere; }
  .upd-copy { flex: none; height: 24px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-row); background: transparent; color: var(--color-accent); font-size: var(--text-meta); font-weight: var(--weight-medium); cursor: pointer; }
  .upd-copy:hover { background: var(--color-surface-hover); }
  .upd-acts { display: flex; align-items: center; gap: var(--space-2); }
  .upd-busy { display: flex; align-items: center; gap: var(--space-2); min-height: var(--size-hit); color: var(--color-text-muted); }
  .upd-spin { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--color-border); border-top-color: var(--color-accent); animation: upd-spin .8s linear infinite; }
  @keyframes upd-spin { to { transform: rotate(360deg); } }
  .upd-opt { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); padding-top: var(--space-3); border-top: var(--hairline); font-size: var(--text-meta); color: var(--color-text-muted); cursor: pointer; user-select: none; }
  .upd-opt input { margin: 0; accent-color: var(--color-accent-fill); }
  @media (prefers-reduced-motion: reduce) { .upd-pop { animation: none; } .upd-spin { animation-duration: 2.4s; } }

  /* ---- right panel: browser + terminal tabs ---- */
  #panel { flex: none; width: 520px; min-width: 300px; max-width: 80vw; border-left: var(--hairline); display: flex; flex-direction: column; min-height: 0; position: relative; background: var(--color-bg); }
  #panel[hidden] { display: none; }
  #panelgrip { position: absolute; left: -2px; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 6; }
  #panelgrip::after { content: ""; position: absolute; left: 1px; top: 0; bottom: 0; width: 2px; background: transparent; transition: background-color var(--motion-fast) var(--ease-out); }
  #panelgrip:hover::after, body.dragging #panelgrip::after { background: var(--color-border-strong); }
  body.dragging { cursor: col-resize; user-select: none; }
  body.dragging iframe { pointer-events: none; }
  #paneltabs { display: flex; align-items: center; gap: 2px; padding: 0 var(--space-2); height: 44px; background: var(--color-surface); border-bottom: var(--hairline); overflow-x: auto; flex: none; }
  .ptab { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 var(--space-1) 0 var(--space-2); border-radius: var(--radius-control); border: 1px solid transparent; color: var(--color-text-muted); cursor: pointer; font-size: var(--text-compact); white-space: nowrap; max-width: 210px; flex: none; }
  .ptab:hover { color: var(--color-text); background: var(--color-surface-hover); }
  .ptab.on { color: var(--color-text); background: var(--color-surface-raised); border-color: var(--color-border); }
  .ptab .ico { font-family: var(--font-mono); font-size: var(--text-micro); color: var(--color-text-muted); }
  .ptab .lbl { overflow: hidden; text-overflow: ellipsis; }
  .ptab .x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: var(--radius-badge); color: var(--color-text-muted); opacity: 0; }
  .ptab:hover .x, .ptab.on .x { opacity: 1; }
  .ptab .x:hover { color: var(--color-danger); background: var(--color-surface-hover); }
  #panelviews { flex: 1; min-height: 0; display: flex; }
  .panelview { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .panelview[hidden] { display: none; }
  .tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .tabbody[hidden] { display: none; }
  .tabbody.browser .bar { display: flex; gap: var(--space-1); padding: var(--space-2); border-bottom: var(--hairline); align-items: center; flex: none; }
  .tabbody.browser .bar input { flex: 1; min-width: 0; height: var(--size-row); font-size: var(--text-compact); }
  /* The previewed page's own canvas, not app chrome. */
  .tabbody.browser iframe { flex: 1; border: 0; background: white; width: 100%; min-height: 0; }
  .tabbody.browser iframe[hidden] { display: none; }
  .tabbody.browser .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-5); color: var(--color-text-muted); text-align: center; font-size: var(--text-compact); }
  .tabbody.browser .empty[hidden] { display: none; }
  .tabbody.browser .empty .urls { display: flex; flex-direction: column; gap: var(--space-1); }
  .tabbody.browser .empty .urls .ghost { height: var(--size-row); font-family: var(--font-mono); font-size: var(--text-meta); font-weight: var(--weight-regular); }
  .tabbody.term { background: var(--color-bg); font-family: var(--font-mono); font-size: var(--text-code); }
  .tabbody.term .out { flex: 1; overflow-y: auto; margin: 0; padding: 10px var(--space-3); white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 1.4; color: var(--color-text); }
  .tabbody.term .out .l { min-height: 1.4em; }
  .tabbody.term .trow { display: flex; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-top: var(--hairline); align-items: baseline; flex: none; }
  /* Like the composer: focus shows on the row's rule, not a second ring. */
  .tabbody.term .trow:focus-within { box-shadow: inset 0 2px 0 var(--color-focus-ring); }
  .tabbody.term input:focus-visible { outline: none; }
  .tabbody.term .prompt { color: var(--color-accent); white-space: nowrap; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
  .tabbody.term input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--color-text); font: inherit; }
  /* ANSI colours map to the status tokens (256-colour and truecolor are ignored). */
  .ab { font-weight: var(--weight-semibold); } .ad { opacity: .64; }
  .a30, .a90 { color: var(--color-text-muted); }
  .a31, .a91 { color: var(--color-danger); }
  .a32, .a92 { color: var(--color-success); }
  .a33, .a93 { color: var(--color-warning); }
  .a34, .a94, .a35, .a95 { color: var(--color-accent); }
  .a36, .a96 { color: var(--color-info); }
  .a37, .a97 { color: var(--color-text); }

  /* ---- dialogs: folder picker, keyboard shortcuts ---- */
  #modal { position: fixed; inset: 0; background: var(--color-overlay); display: flex; align-items: center; justify-content: center; z-index: 50; animation: fade-in var(--motion-base) var(--ease-out); }
  #modal[hidden] { display: none; }
  .dlg { width: min(680px, 92vw); max-height: 82vh; padding: 0; background: var(--color-surface-raised); color: var(--color-text); border: var(--hairline); border-radius: var(--radius-card); display: flex; flex-direction: column; box-shadow: var(--shadow-popover); overflow: hidden; animation: grow-in var(--motion-base) var(--ease-out); }
  dialog.dlg:not([open]) { display: none; }
  dialog.dlg { width: min(440px, 92vw); }
  dialog.dlg::backdrop { background: var(--color-overlay); }
  .dlghdr { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5); border-bottom: var(--hairline); font-size: var(--text-title); line-height: var(--leading-title); letter-spacing: var(--tracking-title); font-weight: var(--weight-semibold); }
  .pathrow { display: flex; gap: var(--space-2); padding: var(--space-4) var(--space-5) var(--space-2); }
  .pathrow input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--text-compact); }
  #fsroots { padding: 0 var(--space-5) var(--space-2); display: flex; gap: var(--space-1); flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; background: transparent; border: var(--hairline); border-radius: var(--radius-pill); color: var(--color-text-muted); font-size: var(--text-meta); cursor: pointer; }
  .chip:hover { color: var(--color-text); border-color: var(--color-border-strong); }
  #fslist { flex: 1; overflow-y: auto; padding: 0 var(--space-3) var(--space-2); min-height: 240px; }
  .fsitem { display: flex; gap: var(--space-3); align-items: center; min-height: var(--size-row); padding: 0 var(--space-2); border-radius: var(--radius-row); cursor: pointer; }
  .fsitem:hover { background: var(--color-surface-hover); }
  .fsitem .proj { margin-inline-start: auto; padding: 0 6px; font-size: var(--text-micro); font-weight: var(--weight-medium); color: var(--color-accent); background: var(--color-accent-soft); border-radius: var(--radius-badge); }
  .fsitem.up { color: var(--color-text-muted); }
  .dlgfoot { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-5); border-top: var(--hairline); font-size: var(--text-compact); color: var(--color-text-muted); }
  .dlgfoot label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  input[type="checkbox"] { accent-color: var(--color-accent-fill); width: 16px; height: 16px; margin: 0; }
  .shortcut-list { display: flex; flex-direction: column; gap: 2px; padding: var(--space-5); font-size: var(--text-ui); line-height: 2; }
  .shortcut-list .ghost { align-self: flex-end; margin-top: var(--space-3); }

  /* ---- long sessions: rows off screen are not laid out (D10) ---- */
  /* Only the heavy rows: small status lines are cheaper to lay out than to
     estimate, and a wrong estimate shifts the scrollbar when they appear. */
  .log > .md, .log > details.tool, .log > details.thought, .log > .user, .log > .plan { content-visibility: auto; contain-intrinsic-size: auto var(--row-estimate); }
  .log > details.tool, .log > details.thought { contain-intrinsic-size: auto var(--row-estimate-tool); }
  .log > .md { contain-intrinsic-size: auto var(--row-estimate-md); }
  /* Following the bottom pins scrollTop itself; while reading, let the
     browser keep the text still as rows above change size. */
  #logwrap.reading { overflow-anchor: auto; }

  /* ---- responsive ---- */
  /* Narrow windows: the sidebar floats over the chat (hairline edge, no
     shadow) and the panel cannot take more than half the width. */
  #sidescrim { display: none; }
  @media (max-width: 1000px) {
    #side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 20; }
    #sidescrim:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 19; background: var(--color-overlay); animation: fade-in var(--motion-base) var(--ease-out); }
    #sidetoggle { display: inline-flex; }
    #panel { max-width: 55vw; }
  }
  @media (max-width: 600px) {
    #top { padding: 0 var(--space-2) 0 var(--space-3); }
    #logs, #busywrap { padding-left: var(--space-4); padding-right: var(--space-4); }
    #bottom { padding: 0 var(--space-3) var(--space-3); }
    #welcome { padding-left: var(--space-6); padding-right: var(--space-6); }
    #panel { position: absolute; inset: var(--size-topbar) 0 0; width: 100% !important; max-width: 100%; z-index: 15; }
    .modelpick { max-width: 150px; }
  }
  /* Touch: row actions always visible, 44px targets. */
  @media (hover: none) {
    .wshdr .iconbtn, .sess .iconbtn, .toast-x, .thought-expand, .thought-collapse, .ptab .x { opacity: 1; }
  }
  @media (pointer: coarse) {
    .iconbtn, #top .iconbtn, .statusbtn, #actionbtn, .chooser-row, #menu .item { min-height: 44px; }
    .iconbtn, #actionbtn { min-width: 44px; }
  }

  /* ---- reduced motion: everything instant, pulses become static dots ---- */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
    .tool.running > summary::before, .tool.argsrow::before, .thought.live .thought-preview::before,
    .sess.busy .dot, .sess.starting .dot, #busy .spin { animation: none; }
  }
`;

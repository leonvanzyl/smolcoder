// Sidebar, project list and session-row styles. Kept apart from styles.ts so
// the sidebar can evolve on its own; both use the DESIGN.md tokens defined
// in styles.ts (:root). Loaded after STYLES, so rules here win on equal
// specificity. Every token carries its DESIGN.md light value as a fallback,
// so the sidebar renders before (or without) the token block. Rules are
// scoped under #side where they replace older generic ones (.sess, .wshdr).

export const SIDEBAR_STYLES = String.raw`
  #side {
    position: relative; width: var(--size-sidebar, 256px); min-width: 0;
    background: var(--color-sidebar, #fafafa); color: var(--color-text, #18181b);
    border-right: 1px solid var(--color-border, #e4e4e7);
    font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, "Inter Variable", Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
    font-size: var(--text-ui, 14px); line-height: var(--leading-ui, 1.43);
  }
  #side .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  #side .sidehdr { padding: var(--space-3, 12px) var(--space-3, 12px) var(--space-1, 4px) 14px; }
  #side .sidefoot { border-top: 1px solid var(--color-border, #e4e4e7); color: var(--color-text-muted, #696972); font-size: var(--text-meta, 12px); padding: var(--space-2, 8px) var(--space-3, 12px); }
  #side .sidefoot .iconbtn { color: var(--color-text-muted, #696972); }

  /* ---- header: search + three icon buttons ---- */
  .sb-head { display: flex; align-items: center; gap: var(--space-1, 4px); padding: var(--space-2, 8px); }
  .sb-search { flex: 1; min-width: 0; height: var(--size-hit, 32px); display: flex; align-items: center; gap: 6px; padding: 0 var(--space-2, 8px); border-radius: var(--radius-control, 8px); color: var(--color-text-muted, #696972); cursor: text; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-search:hover, .sb-search:focus-within { background: var(--color-surface-hover, #ededef); }
  .sb-search:focus-within { box-shadow: inset 0 0 0 2px var(--color-focus-ring, #1b4ed8); }
  .sb-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text, #18181b); font: inherit; font-size: var(--text-ui, 14px); padding: 0; }
  .sb-search input::placeholder { color: var(--color-text-muted, #696972); }
  .sb-search input::-webkit-search-cancel-button { display: none; }
  .sb-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; color: inherit; }
  .sb-glyph svg { display: block; }
  .sb-searchglyph svg { width: 14px; height: 14px; }
  .sb-iconbtn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: var(--size-row, 28px); height: var(--size-row, 28px); padding: 0; border: 0; border-radius: var(--radius-control, 8px); background: transparent; color: var(--color-text-muted, #696972); cursor: pointer; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out), color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-iconbtn:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  .sb-iconbtn.on { background: var(--color-accent-soft, #e6ebf8); color: var(--color-accent, #1b4ed8); }
  .sb-iconbtn:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  #side #openfolder { margin: 0; padding: 0; text-align: center; }
  .sb-filterbar { display: flex; align-items: center; gap: var(--space-2, 8px); margin: 0 var(--space-2, 8px) var(--space-1, 4px); padding: 0 10px; height: 24px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-linkbtn, .sb-more, .sb-undobtn { border: 0; background: transparent; padding: 0; font: inherit; color: var(--color-accent, #1b4ed8); cursor: pointer; }
  .sb-linkbtn:hover, .sb-more:hover, .sb-undobtn:hover { text-decoration: underline; text-underline-offset: 2px; }

  /* ---- the list ---- */
  #side #wslist { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 var(--space-2, 8px) var(--space-2, 8px); display: flex; flex-direction: column; }
  .sb-empty, .sb-noresults { padding: var(--space-4, 16px) 10px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); text-align: center; }
  .sb-folders { display: flex; flex-direction: column; }
  .sb-pinned { display: flex; flex-direction: column; gap: 2px; }
  .sb-sep { height: 1px; margin: var(--space-2, 8px) 10px; background: var(--color-border, #e4e4e7); flex: none; }

  /* folder header: 32px row, icon, name, (count + dot), pen, chevron */
  #side .ws { margin: 0; }
  #side .ws + .ws { margin-top: var(--space-2, 8px); }
  #side .wshdr { height: 32px; padding: 0 6px 0 10px; gap: var(--space-2, 8px); border-radius: var(--radius-row, 6px); color: var(--color-text, #18181b); font-size: var(--text-ui, 14px); cursor: pointer; user-select: none; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  #side .wshdr:hover { background: var(--color-surface-hover, #ededef); }
  #side .wshdr:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  #side .wshdr.drop { box-shadow: inset 0 0 0 1px var(--color-accent, #1b4ed8); background: var(--color-accent-soft, #e6ebf8); }
  #side .wsname { flex: 0 1 auto; min-width: 0; max-width: none; font-weight: var(--weight-medium, 500); color: var(--color-text, #18181b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-favicon { width: 16px; height: 16px; flex: none; border-radius: var(--radius-badge, 4px); object-fit: contain; }
  .sb-mono { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-badge, 4px); font-size: var(--text-micro, 11px); font-weight: var(--weight-semibold, 600); line-height: 1; }
  .sb-mono.h0 { color: var(--color-info, #0069a8); background: color-mix(in srgb, var(--color-info, #0069a8) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h1 { color: var(--color-success, #007a55); background: color-mix(in srgb, var(--color-success, #007a55) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h2 { color: var(--color-danger, #c10007); background: color-mix(in srgb, var(--color-danger, #c10007) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h3 { color: var(--color-warning, #ad4700); background: color-mix(in srgb, var(--color-warning, #ad4700) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h4 { color: var(--color-accent, #1b4ed8); background: color-mix(in srgb, var(--color-accent, #1b4ed8) 15%, var(--color-sidebar, #fafafa)); }
  .sb-pinmark { color: var(--color-text-muted, #696972); }
  .sb-pinmark svg, .sb-draft svg, .sb-branch svg { width: 12px; height: 12px; }
  .sb-count { font-size: var(--text-micro, 11px); font-weight: var(--weight-medium, 500); color: var(--color-text-muted, #696972); font-variant-numeric: tabular-nums; }
  .sb-chev { color: var(--color-text-muted, #696972); transition: transform var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-chev svg { width: 12px; height: 12px; }
  .collapsed > .wshdr .sb-chev, .sb-shelf:not(.open) .sb-chev { transform: rotate(-90deg); }
  .sb-fnew { width: 24px; height: 24px; opacity: 0; }
  .sb-fnew svg, .sb-act svg { width: 14px; height: 14px; }
  #side .wshdr:hover .sb-fnew, #side .wshdr:focus-within .sb-fnew, #side .wshdr:focus-visible .sb-fnew { opacity: 1; }
  #side .sessions { display: flex; flex-direction: column; gap: 2px; padding-top: 2px; }
  .sb-newrow { height: 32px; padding: 0 10px; border: 0; background: transparent; border-radius: var(--radius-row, 6px); text-align: left; font: inherit; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); cursor: pointer; }
  .sb-newrow:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }

  /* ---- session rows: cards (live, unread) and slim rows (stored, archived) ---- */
  #side .sess { position: relative; display: flex; gap: 0; padding: 0; border-radius: var(--radius-row, 6px); color: var(--color-text, #18181b); font-size: var(--text-ui, 14px); cursor: pointer; background: transparent; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  #side .sess:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  #side .sess:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  #side .sess.active { background: var(--color-sidebar-row-active, #ffffff); box-shadow: inset 0 0 0 1px var(--color-border, #e4e4e7); color: var(--color-text, #18181b); }
  #side .sess.unread .stitle::after { content: none; }
  #side .stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #side .stitle.untitled { font-style: normal; color: var(--color-text-muted, #696972); }
  #side .stime { display: inline; flex: none; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); font-variant-numeric: tabular-nums; }
  #side .sess:hover .stime { display: inline; }
  #side .sess.sb-card { flex-direction: column; align-items: stretch; justify-content: center; min-height: 52px; padding: var(--space-2, 8px) 10px; gap: 2px; }
  #side .sess.sb-card:has(.sb-l3) { min-height: 72px; }
  .sb-l1, .sb-l2, .sb-l3 { display: flex; align-items: center; gap: var(--space-1, 4px); min-width: 0; }
  .sb-l1 { height: 20px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-l2 { min-height: 20px; }
  .sb-card .stitle { font-weight: var(--weight-medium, 500); }
  .sb-l3 { height: 18px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  #side .sess.sb-slim { align-items: center; height: 32px; padding: 0 10px; gap: var(--space-2, 8px); }
  .sb-slim .stitle { color: var(--color-text-muted, #696972); font-weight: var(--weight-regular, 400); }
  .sb-slim:hover .stitle, .sb-slim:focus-visible .stitle, .sb-slim.active .stitle { color: var(--color-text, #18181b); }
  .sb-slim .sb-meta { flex: 0 1 auto; max-width: 40%; }
  .sb-draft { color: var(--color-text-muted, #696972); margin-right: 2px; }
  .sb-branch { display: inline-flex; align-items: center; gap: var(--space-1, 4px); min-width: 0; }
  .sb-branchname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-diff { display: inline-flex; gap: 6px; font-family: var(--font-mono, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace); font-variant-numeric: tabular-nums; }
  .sb-diff .add { color: var(--color-success, #007a55); }
  .sb-diff .del { color: var(--color-danger, #c10007); }

  /* status slot: dot + label, never colour alone */
  .sb-status { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sb-status.info { color: var(--color-info, #0069a8); }
  .sb-status.success { color: var(--color-success, #007a55); }
  .sb-status.danger { color: var(--color-danger, #c10007); }
  .sb-status.warning { color: var(--color-warning, #ad4700); }
  .sb-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; }
  .sb-dot.info { background: var(--color-info, #0069a8); }
  .sb-dot.success { background: var(--color-success, #007a55); }
  .sb-dot.danger { background: var(--color-danger, #c10007); }
  .sb-dot.warning { background: var(--color-warning, #ad4700); }
  .sb-dot.pulse { animation: sb-pulse 2s infinite; }
  @keyframes sb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

  /* hover / focus swaps the status slot for the row actions */
  .sb-acts { display: none; align-items: center; gap: 2px; flex: none; margin: -4px -4px -4px 0; }
  .sb-act { width: 24px; height: 24px; }
  #side .sess:hover > .sb-acts, #side .sess:focus-within > .sb-acts, #side .sess:hover > .sb-l1 > .sb-acts, #side .sess:focus-within > .sb-l1 > .sb-acts { display: inline-flex; }
  #side .sess:hover > .sb-status, #side .sess:focus-within > .sb-status, #side .sess:hover > .sb-l1 > .sb-status, #side .sess:focus-within > .sb-l1 > .sb-status,
  #side .sess:hover > .stime, #side .sess:focus-within > .stime, #side .sess:hover > .sb-l1 > .stime, #side .sess:focus-within > .sb-l1 > .stime { display: none; }
  #side .sess .stitle.renaming { flex: 1; min-width: 0; height: 24px; margin: 0; padding: 0 6px; font: inherit; font-size: var(--text-ui, 14px); font-weight: var(--weight-medium, 500); color: var(--color-text, #18181b); background: var(--color-surface-raised, #ffffff); border: 1px solid var(--color-border-strong, #86868f); border-radius: var(--radius-badge, 4px); }
  #side .sess .stitle.renaming:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: 0; }

  /* Alt held: jump hints on the first nine rows */
  .sb-hint { display: none; flex: none; margin-left: var(--space-1, 4px); min-width: 16px; height: 16px; padding: 0 4px; align-items: center; justify-content: center; border-radius: var(--radius-badge, 4px); border: 1px solid var(--color-border-strong, #86868f); background: var(--color-surface-raised, #ffffff); color: var(--color-text, #18181b); font-family: var(--font-mono, "SF Mono", Menlo, Consolas, monospace); font-size: var(--text-micro, 11px); line-height: 1; }
  #side.alt-held .sb-hint { display: inline-flex; }
  #side.alt-held .sess > .sb-status, #side.alt-held .sess > .sb-l1 > .sb-status { display: inline-flex; }

  /* ---- shelves ---- */
  .sb-shelf { margin-top: auto; padding-top: var(--space-2, 8px); }
  .sb-shelfhdr { width: 100%; height: var(--size-row, 28px); display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; border: 0; border-radius: var(--radius-row, 6px); background: transparent; font: inherit; font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); color: var(--color-text-muted, #696972); cursor: pointer; }
  .sb-shelfhdr:hover { background: var(--color-surface-hover, #ededef); }
  .sb-shelfhdr:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  .sb-more { margin: var(--space-1, 4px) 10px; font-size: var(--text-meta, 12px); align-self: flex-start; }

  /* ---- search results ---- */
  .sb-results { display: flex; flex-direction: column; gap: 2px; }
  #side .sb-result { flex-direction: column; align-items: stretch; padding: 6px 10px; gap: 2px; }
  #side .sb-result.sel { background: var(--color-accent-soft, #e6ebf8); }
  .sb-result .sb-meta { flex: none; max-width: 45%; }
  .sb-result .stitle { font-weight: var(--weight-medium, 500); }
  .sb-snippet { font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #side .sb-result.sel .sb-snippet, #side .sb-result.sel .sb-meta { color: var(--color-text, #18181b); }
  .sb-snippet mark { background: transparent; color: var(--color-text, #18181b); font-weight: var(--weight-medium, 500); }

  /* ---- undo notice ---- */
  .sb-undo { display: flex; align-items: center; gap: var(--space-2, 8px); height: 0; overflow: hidden; padding: 0 var(--space-3, 12px); font-size: var(--text-micro, 11px); color: var(--color-text-muted, #696972); opacity: 0; transition: opacity var(--motion-base, 200ms) var(--ease-out, ease-out); }
  .sb-undo.on { height: 24px; opacity: 1; border-top: 1px solid var(--color-border, #e4e4e7); }
  .sb-undomsg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-undobtn { font-size: var(--text-micro, 11px); font-weight: var(--weight-medium, 500); }

  /* ---- resize rail ---- */
  .sb-rail { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 5; touch-action: none; }
  .sb-rail::after { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: transparent; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-rail:hover::after, body.sb-resizing .sb-rail::after { background: var(--color-border-strong, #86868f); }
  body.sb-resizing, body.sb-resizing * { cursor: col-resize !important; user-select: none !important; }

  /* ---- menus and the branch field (floating: the one place with a shadow) ---- */
  .sb-menu { position: fixed; z-index: 80; min-width: 220px; max-width: 320px; padding: var(--space-1, 4px); display: flex; flex-direction: column; background: var(--color-surface-raised, #ffffff); color: var(--color-text, #18181b); border: 1px solid var(--color-border, #e4e4e7); border-radius: var(--radius-control, 8px); box-shadow: var(--shadow-popover, 0 16px 40px -18px rgba(0,0,0,.35)); font-family: var(--font-ui, system-ui, sans-serif); font-size: var(--text-ui, 14px); animation: sb-pop var(--motion-base, 200ms) var(--ease-out, ease-out); }
  @keyframes sb-pop { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
  .sb-menu-item { display: flex; align-items: center; gap: var(--space-2, 8px); height: 32px; padding: 0 10px; border: 0; border-radius: var(--radius-row, 6px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .sb-menu-item:hover, .sb-menu-item:focus { background: var(--color-surface-hover, #ededef); outline: 0; }
  .sb-menu-item:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  .sb-menu-item.danger { color: var(--color-danger, #c10007); }
  .sb-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-menu-key { font-family: var(--font-mono, monospace); font-size: var(--text-micro, 11px); color: var(--color-text-muted, #696972); border: 1px solid var(--color-border, #e4e4e7); border-radius: var(--radius-badge, 4px); padding: 0 4px; }
  .sb-menu-sep { height: 1px; margin: var(--space-1, 4px) 6px; background: var(--color-border, #e4e4e7); }
  .sb-menu-title { padding: 6px 8px 4px; font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); color: var(--color-text-muted, #696972); }
  .sb-menu-hint { padding: 4px 8px 6px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-branchbox { min-width: 300px; }
  .sb-branchin { margin: 4px; height: 32px; padding: 0 10px; font: inherit; font-family: var(--font-mono, monospace); font-size: var(--text-compact, 13px); color: var(--color-text, #18181b); background: var(--color-surface-raised, #ffffff); border: 1px solid var(--color-border-strong, #86868f); border-radius: var(--radius-control, 8px); }
  .sb-branchin:focus { border-color: var(--color-focus-ring, #1b4ed8); outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: 1px; }

  /* the welcome column's second line */
  .sb-welcome-sub { margin: -12px 0 20px; color: var(--color-text-muted, #696972); font-size: var(--text-ui, 14px); }

  /* touch: row actions and the folder pen are always there */
  @media (pointer: coarse) {
    .sb-acts { display: inline-flex; }
    .sb-fnew { opacity: 1; }
    #side .sess > .stime, #side .sess > .sb-l1 > .stime { display: none; }
    .sb-iconbtn { width: 44px; height: 44px; }
    .sb-rail { width: 16px; right: -8px; }
  }
  @media (max-width: 1000px) {
    #side { box-shadow: none; border-right: 1px solid var(--color-border, #e4e4e7); }
  }
  @media (prefers-reduced-motion: reduce) {
    .sb-dot.pulse { animation: none; }
    .sb-menu { animation: none; }
    .sb-chev, .sb-undo, .sb-search, .sb-iconbtn, #side .sess, #side .wshdr { transition: none; }
  }
`;

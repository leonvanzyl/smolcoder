// Sidebar, project list and session-row styles. Kept apart from styles.ts so
// the sidebar can evolve on its own; both use the DESIGN.md tokens defined
// in styles.ts (:root). Loaded after STYLES, so rules here win on equal
// specificity. Every token carries its DESIGN.md light value as a fallback,
// so the sidebar renders before (or without) the token block. Rules are
// scoped under #side where they replace older generic ones (.sess, .wshdr).
//
// The spacing system (DESIGN.md "Sidebar spacing"):
//   8px  list inset left and right (--sb-inset)
//   10px row padding and icon-to-label gap (--sb-pad)
//   36px title indent: 10px pad + 16px icon + 10px gap (--sb-indent), so a
//        session title lines up with its folder's name, and a shelf row's
//        project icon sits where the folder icon does
//   32px folder header (--size-hit), 36px session row (--sb-row)
//   1px  between rows, 12px between folders (--sb-group-gap)
//   28px section labels (Pinned, Projects, Archived)

export const SIDEBAR_STYLES = String.raw`
  #side {
    --sb-inset: 8px; --sb-pad: 10px; --sb-indent: 36px; --sb-row: 36px; --sb-group-gap: 12px;
    position: relative; width: var(--size-sidebar, 256px); min-width: 0;
    background: var(--color-sidebar, #fafafa); color: var(--color-text, #18181b);
    border-right: 1px solid var(--color-border, #e4e4e7);
    font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, "Inter Variable", Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
    font-size: var(--text-ui, 14px); line-height: var(--leading-ui, 1.43);
  }
  #side .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* ---- header: the logo row is as tall as the top bar, so the two line up ---- */
  #side .sidehdr { flex: none; display: flex; align-items: center; gap: var(--space-2, 8px); height: var(--size-topbar, 52px); padding: 0 var(--sb-inset) 0 18px; }
  #side .brand { font-size: 5px; line-height: 1.15; letter-spacing: 0; user-select: none; }
  #side .sidehdr .iconbtn, #side .sidefoot .iconbtn { width: var(--size-row, 28px); min-width: var(--size-row, 28px); height: var(--size-row, 28px); padding: 0; color: var(--color-text-muted, #696972); }
  #side .sidehdr .iconbtn:hover, #side .sidefoot .iconbtn:hover { color: var(--color-text, #18181b); }

  /* ---- search + three icon buttons ---- */
  .sb-head { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 var(--sb-inset) var(--sb-inset); }
  .sb-search { flex: 1; min-width: 0; height: var(--size-hit, 32px); display: flex; align-items: center; gap: var(--space-2, 8px); padding: 0 var(--space-2, 8px); border-radius: var(--radius-control, 8px); color: var(--color-text-muted, #696972); cursor: text; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-search:hover, .sb-search:focus-within { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  .sb-search:focus-within { box-shadow: inset 0 0 0 2px var(--color-focus-ring, #1b4ed8); }
  .sb-search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--color-text, #18181b); font: inherit; font-size: var(--text-ui, 14px); padding: 0; }
  .sb-search input::placeholder { color: var(--color-text-muted, #696972); }
  .sb-search input::-webkit-search-cancel-button { display: none; }
  .sb-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; color: inherit; }
  .sb-glyph svg { display: block; }
  .sb-searchglyph svg { width: 16px; height: 16px; }
  .sb-iconbtn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: var(--size-row, 28px); height: var(--size-row, 28px); padding: 0; border: 0; border-radius: var(--radius-control, 8px); background: transparent; color: var(--color-text-muted, #696972); cursor: pointer; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out), color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-iconbtn:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  .sb-iconbtn.on { background: var(--color-accent-soft, #e6ebf8); color: var(--color-accent, #1b4ed8); }
  .sb-iconbtn:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  .sb-iconbtn svg { width: 16px; height: 16px; }
  #side #openfolder { margin: 0; padding: 0; text-align: center; }
  .sb-filterbar { flex: none; display: flex; align-items: center; gap: var(--space-2, 8px); margin: 0 var(--sb-inset) var(--space-2, 8px); padding: 0 var(--sb-pad); height: 28px; border-radius: var(--radius-row, 6px); background: var(--color-surface-hover, #ededef); font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-filterbar > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text, #18181b); }
  .sb-linkbtn, .sb-more, .sb-undobtn { border: 0; background: transparent; padding: 0; font: inherit; color: var(--color-accent, #1b4ed8); cursor: pointer; }
  .sb-linkbtn:hover, .sb-more:hover, .sb-undobtn:hover { text-decoration: underline; text-underline-offset: 2px; }

  /* ---- the list ---- */
  #side #wslist { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 var(--sb-inset) var(--space-3, 12px); display: flex; flex-direction: column; }
  .sb-empty, .sb-noresults { padding: var(--space-6, 24px) var(--sb-pad); font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); text-align: center; }
  .sb-folders { display: flex; flex-direction: column; gap: var(--sb-group-gap); }
  .sb-pinned { display: flex; flex-direction: column; gap: 1px; margin-bottom: var(--space-3, 12px); }

  /* section labels: Pinned, Projects (only beside Pinned), Archived */
  .sb-section, .sb-shelfhdr { display: flex; align-items: center; gap: var(--space-2, 8px); height: var(--size-row, 28px); padding: 0 var(--sb-pad); font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); color: var(--color-text-muted, #696972); user-select: none; }
  .sb-section { flex: none; }
  .sb-section-label { flex: none; }
  .sb-rule { flex: 1; height: 1px; background: var(--color-border, #e4e4e7); }

  /* folder header: 32px; icon, name, (count + dot), pen, chevron */
  #side .ws { margin: 0; }
  #side .wshdr { height: var(--size-hit, 32px); padding: 0 6px 0 var(--sb-pad); gap: var(--sb-pad); border-radius: var(--radius-row, 6px); color: var(--color-text, #18181b); font-size: var(--text-ui, 14px); cursor: pointer; user-select: none; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  #side .wshdr:hover { background: var(--color-surface-hover, #ededef); }
  #side .wshdr:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  #side .wshdr.drop { box-shadow: inset 0 0 0 1px var(--color-accent, #1b4ed8); background: var(--color-accent-soft, #e6ebf8); }
  #side .wsname { flex: 0 1 auto; min-width: 0; max-width: none; font-weight: var(--weight-medium, 500); color: var(--color-text, #18181b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #side .wshdr .sb-pinmark { margin-left: calc(-1 * var(--space-1, 4px)); }
  .sb-favicon { width: 16px; height: 16px; flex: none; border-radius: var(--radius-badge, 4px); object-fit: contain; }
  .sb-mono { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-badge, 4px); font-size: 10px; font-weight: var(--weight-semibold, 600); line-height: 1; }
  .sb-mono.h0 { color: var(--color-info, #0069a8); background: color-mix(in srgb, var(--color-info, #0069a8) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h1 { color: var(--color-success, #007a55); background: color-mix(in srgb, var(--color-success, #007a55) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h2 { color: var(--color-danger, #c10007); background: color-mix(in srgb, var(--color-danger, #c10007) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h3 { color: var(--color-warning, #ad4700); background: color-mix(in srgb, var(--color-warning, #ad4700) 15%, var(--color-sidebar, #fafafa)); }
  .sb-mono.h4 { color: var(--color-accent, #1b4ed8); background: color-mix(in srgb, var(--color-accent, #1b4ed8) 15%, var(--color-sidebar, #fafafa)); }
  .sb-pinmark, .sb-wtmark, .sb-draft { color: var(--color-text-muted, #696972); }
  .sb-pinmark svg, .sb-draft svg, .sb-wtmark svg, .sb-branch svg { width: 12px; height: 12px; }
  .sb-count { flex: none; font-size: var(--text-meta, 12px); font-weight: var(--weight-regular, 400); color: var(--color-text-muted, #696972); font-variant-numeric: tabular-nums; }
  .sb-chev { flex: none; width: 16px; justify-content: center; color: var(--color-text-muted, #696972); transition: transform var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-chev svg { width: 12px; height: 12px; }
  .collapsed > .wshdr .sb-chev, .sb-shelf:not(.open) .sb-chev { transform: rotate(-90deg); }
  .sb-fnew { width: 24px; height: 24px; opacity: 0; margin-right: -6px; }
  .sb-fnew svg, .sb-act svg { width: 14px; height: 14px; }
  #side .wshdr:hover .sb-fnew, #side .wshdr:focus-within .sb-fnew, #side .wshdr:focus-visible .sb-fnew { opacity: 1; }
  #side .sessions { display: flex; flex-direction: column; gap: 1px; margin-top: 1px; }
  .sb-newrow { height: var(--sb-row); padding: 0 var(--sb-pad) 0 var(--sb-indent); border: 0; background: transparent; border-radius: var(--radius-row, 6px); text-align: left; font: inherit; font-size: var(--text-ui, 14px); color: var(--color-text-muted, #696972); cursor: pointer; }
  .sb-newrow:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }

  /* ---- session rows: one 36px line everywhere ---- */
  #side .sess { position: relative; display: flex; align-items: center; flex: none; gap: var(--space-2, 8px); height: var(--sb-row); padding: 0 var(--sb-pad) 0 var(--sb-indent); border-radius: var(--radius-row, 6px); color: var(--color-text, #18181b); font-size: var(--text-ui, 14px); cursor: pointer; background: transparent; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  #side .sess:hover { background: var(--color-surface-hover, #ededef); }
  #side .sess:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  #side .sess.active { background: var(--color-sidebar-row-active, #ffffff); box-shadow: inset 0 0 0 1px var(--color-sidebar-row-ring, #e4e4e7); }
  /* rows from many projects (Pinned, Archived, search): the project icon in the indent */
  #side .sess.sb-lead { padding-left: var(--sb-pad); }
  .sb-leadicon { margin-right: 2px; }
  #side .sess.unread .stitle::after { content: none; }
  #side .stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium, 500); color: var(--color-text, #18181b); }
  #side .stitle.untitled { font-style: normal; }
  #side .sess.recede .stitle { font-weight: var(--weight-regular, 400); color: var(--color-text-muted, #696972); transition: color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  #side .sess.recede:hover .stitle, #side .sess.recede:focus-visible .stitle, #side .sess.recede.active .stitle { color: var(--color-text, #18181b); }
  #side .stime { display: inline; flex: none; min-width: 24px; text-align: right; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); font-variant-numeric: tabular-nums; }
  .sb-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-draft { margin-right: -2px; }
  .sb-branch { display: inline-flex; align-items: center; gap: var(--space-1, 4px); min-width: 0; }
  .sb-branchname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-diff { display: inline-flex; gap: 6px; font-family: var(--font-mono, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace); font-size: var(--text-meta, 12px); font-variant-numeric: tabular-nums; }
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
  .sb-acts { display: none; align-items: center; gap: 0; flex: none; margin: 0 -6px 0 0; }
  .sb-act { width: 24px; height: 24px; }
  #side .sess:hover > .sb-acts, #side .sess:focus-within > .sb-acts { display: inline-flex; }
  #side .sess:hover > .sb-status, #side .sess:focus-within > .sb-status,
  #side .sess:hover > .stime, #side .sess:focus-within > .stime { display: none; }
  #side .sess .stitle.renaming { flex: 1; min-width: 0; height: 26px; margin: 0 0 0 -7px; padding: 0 6px; font: inherit; font-size: var(--text-ui, 14px); font-weight: var(--weight-medium, 500); color: var(--color-text, #18181b); background: var(--color-surface-raised, #ffffff); border: 1px solid var(--color-border-strong, #86868f); border-radius: var(--radius-badge, 4px); }
  #side .sess .stitle.renaming:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: 0; }

  /* Alt held: jump hints on the first nine rows */
  .sb-hint { display: none; flex: none; min-width: 18px; height: 18px; padding: 0 4px; align-items: center; justify-content: center; border-radius: var(--radius-badge, 4px); border: 1px solid var(--color-border-strong, #86868f); background: var(--color-surface-raised, #ffffff); color: var(--color-text, #18181b); font-family: var(--font-mono, "SF Mono", Menlo, Consolas, monospace); font-size: var(--text-micro, 11px); line-height: 1; }
  #side.alt-held .sb-hint { display: inline-flex; }
  /* the hint takes the status slot, so the title keeps its width */
  #side.alt-held .sess > .sb-status, #side.alt-held .sess > .stime, #side.alt-held .sess > .sb-acts { display: none; }

  /* ---- the Archived shelf, pinned to the bottom of the list ---- */
  .sb-shelf { margin-top: auto; padding-top: var(--space-5, 20px); display: flex; flex-direction: column; }
  .sb-shelfhdr { width: 100%; padding-right: 6px; border: 0; border-radius: var(--radius-row, 6px); background: transparent; font-family: inherit; cursor: pointer; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out), color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-shelfhdr:hover { background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  .sb-shelfhdr:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  .sb-shelf .sessions { margin-top: 2px; }
  .sb-more { align-self: flex-start; height: var(--size-row, 28px); margin: 2px 0 0; padding: 0 var(--sb-pad) 0 var(--sb-indent); font-size: var(--text-meta, 12px); }

  /* ---- search results: shelf geometry, a snippet under the title ---- */
  .sb-results { display: flex; flex-direction: column; gap: 1px; }
  #side .sb-result { height: auto; min-height: var(--sb-row); flex-direction: column; align-items: stretch; justify-content: center; gap: 0; padding: 6px var(--sb-pad); }
  .sb-rline { display: flex; align-items: center; gap: var(--space-2, 8px); min-width: 0; height: 24px; }
  #side .sb-result.sel { background: var(--color-accent-soft, #e6ebf8); }
  .sb-snippet .sb-meta { font-size: inherit; }
  .sb-snippet { margin: 0 0 2px calc(var(--sb-indent) - var(--sb-pad)); font-size: var(--text-meta, 12px); line-height: 18px; color: var(--color-text-muted, #696972); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #side .sb-result.sel .sb-snippet, #side .sb-result.sel .sb-meta { color: var(--color-text, #18181b); }
  .sb-snippet mark { background: transparent; color: var(--color-text, #18181b); font-weight: var(--weight-medium, 500); }

  /* ---- undo notice ---- */
  .sb-undo { flex: none; display: flex; align-items: center; gap: var(--space-2, 8px); height: 0; overflow: hidden; margin: 0 var(--sb-inset); padding: 0 var(--sb-pad); border-radius: var(--radius-row, 6px); font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); opacity: 0; transition: opacity var(--motion-base, 200ms) var(--ease-out, ease-out); }
  .sb-undo.on { height: 32px; opacity: 1; background: var(--color-surface-hover, #ededef); color: var(--color-text, #18181b); }
  .sb-undomsg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-undobtn { font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); }

  /* ---- footer: a quiet 44px row ---- */
  #side .sidefoot { flex: none; display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 var(--sb-inset) 0 18px; border-top: 0; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sidefoot-brand { color: var(--color-text, #18181b); font-weight: var(--weight-medium, 500); }
  #ver { font-variant-numeric: tabular-nums; }

  /* ---- resize rail ---- */
  .sb-rail { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 5; touch-action: none; }
  .sb-rail::after { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: transparent; transition: background-color var(--motion-fast, 150ms) var(--ease-out, ease-out); }
  .sb-rail:hover::after, body.sb-resizing .sb-rail::after { background: var(--color-border-strong, #86868f); }
  body.sb-resizing, body.sb-resizing * { cursor: col-resize !important; user-select: none !important; }

  /* ---- menus and the branch field (floating: the one place with a shadow) ---- */
  .sb-menu { position: fixed; z-index: 80; min-width: 224px; max-width: 320px; padding: var(--space-1, 4px); display: flex; flex-direction: column; gap: 1px; background: var(--color-surface-raised, #ffffff); color: var(--color-text, #18181b); border: 1px solid var(--color-border, #e4e4e7); border-radius: var(--radius-control, 8px); box-shadow: var(--shadow-popover, 0 16px 40px -18px rgba(0,0,0,.35)); font-family: var(--font-ui, system-ui, sans-serif); font-size: var(--text-ui, 14px); animation: sb-pop var(--motion-base, 200ms) var(--ease-out, ease-out); }
  @keyframes sb-pop { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }
  .sb-menu-item { display: flex; align-items: center; gap: var(--space-2, 8px); height: 32px; padding: 0 var(--space-2, 8px) 0 var(--sb-pad, 10px); border: 0; border-radius: var(--radius-row, 6px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .sb-menu-item:hover, .sb-menu-item:focus { background: var(--color-surface-hover, #ededef); outline: 0; }
  .sb-menu-item:focus-visible { outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: -2px; }
  .sb-menu-item.danger { color: var(--color-danger, #c10007); }
  .sb-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-menu-key { flex: none; font-family: var(--font-mono, monospace); font-size: var(--text-micro, 11px); line-height: 16px; color: var(--color-text-muted, #696972); background: var(--color-surface, #f4f4f5); border: 1px solid var(--color-border, #e4e4e7); border-radius: var(--radius-badge, 4px); padding: 0 5px; }
  .sb-menu-sep { height: 1px; margin: var(--space-1, 4px) var(--sb-pad, 10px); background: var(--color-border, #e4e4e7); }
  .sb-menu-title { padding: 6px var(--sb-pad, 10px) 4px; font-size: var(--text-meta, 12px); font-weight: var(--weight-medium, 500); color: var(--color-text-muted, #696972); }
  .sb-menu-hint { padding: 4px var(--sb-pad, 10px) 6px; font-size: var(--text-meta, 12px); color: var(--color-text-muted, #696972); }
  .sb-branchbox { min-width: 300px; }
  .sb-branchin { margin: 4px; height: 32px; padding: 0 10px; font: inherit; font-family: var(--font-mono, monospace); font-size: var(--text-compact, 13px); color: var(--color-text, #18181b); background: var(--color-surface-raised, #ffffff); border: 1px solid var(--color-border-strong, #86868f); border-radius: var(--radius-control, 8px); }
  .sb-branchin:focus { border-color: var(--color-focus-ring, #1b4ed8); outline: 2px solid var(--color-focus-ring, #1b4ed8); outline-offset: 1px; }

  /* the welcome column's second line */
  .sb-welcome-sub { margin: 0 0 var(--space-6, 24px); color: var(--color-text-muted, #696972); font-size: var(--text-ui, 14px); }

  /* touch: row actions and the folder pen are always there */
  @media (pointer: coarse) {
    .sb-acts { display: inline-flex; }
    .sb-fnew { opacity: 1; }
    #side .sess > .stime { display: none; }
    .sb-iconbtn { width: 44px; height: 44px; }
    .sb-rail { width: 16px; right: -8px; }
  }
  @media (max-width: 1000px) {
    #side { box-shadow: none; border-right: 1px solid var(--color-border, #e4e4e7); }
  }
  @media (prefers-reduced-motion: reduce) {
    .sb-dot.pulse { animation: none; }
    .sb-menu { animation: none; }
    .sb-chev, .sb-undo, .sb-search, .sb-iconbtn, #side .sess, #side .wshdr, .sb-shelfhdr { transition: none; }
  }
`;

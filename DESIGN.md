# smolcoder Web UI — Design System

> A quiet workbench. Near-monochrome zinc in light mode and true black in dark mode. Hairlines and small lightness steps separate the layers. Inter (or SF Pro on Apple) at 14px, and one cobalt blue. The transcript is the content; the chrome stays out of the way.

**Themes:** light and dark, given equal care. There is one token set with two value columns, and the theme follows `prefers-color-scheme`. There is no manual toggle.

smolcoder's web app is a three-part workspace:

- a project and session sidebar;
- the transcript (messages, reasoning, tool calls, diffs, code), with the composer pinned beneath it;
- an optional right panel with browser and terminal tabs.

Nothing is decorative. Layers are told apart by tiny lightness steps (`--color-bg`, `--color-sidebar`, `--color-surface`, `--color-surface-raised`) and 1px hairlines. Floating layers are the one exception and get a single soft shadow. Blue appears only on links, focus, the current selection and primary actions. The only other saturated hues are the status colours (info, success, danger, warning).

Every text pair in both themes passes WCAG AA.

## Tokens — Colors

Use the token, never the hex. Every row has a light and a dark value; components must not branch on theme.

| Token                          | Light     | Dark                    | Role                                                                                     |
| ------------------------------ | --------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `--color-bg`                   | `#fcfcfc` | `#000000`               | Page canvas, transcript, top bar                                                          |
| `--color-sidebar`              | `#fafafa` | `#0a0a0a`               | Sidebar background: one small step off the canvas, plus its hairline                     |
| `--color-surface`              | `#f4f4f5` | `#0a0a0a`               | Code blocks, tool result bodies, right-panel tab strip, inline code, muted wells          |
| `--color-surface-raised`       | `#ffffff` | `#111111`               | Composer, popovers, menus, command palette, dialogs, toasts                               |
| `--color-surface-hover`        | `#ededef` | `#1a1a1b`               | Hover fill for rows on bg or sidebar (sessions, menu items, tool rows), pressed icon button |
| `--color-sidebar-row-active`   | `#ffffff` | `#252527`               | The current session's row: one step above hover, so hover and current never look alike   |
| `--color-message`              | `#ebebed` | `#1e1e1e`               | User message bubble                                                                       |
| `--color-border`               | `#e4e4e7` | `rgba(255,255,255,0.08)`| 1px hairlines: dividers, sidebar edge, card and popover outlines (decorative)             |
| `--color-border-strong`        | `#86868f` | `#6b6b6b`               | Outlines of controls that must be perceivable (>= 3:1): switch track, checkbox, focused-off inputs |
| `--color-text`                 | `#18181b` | `#f5f5f5`               | Body, headings, titles, message text                                                      |
| `--color-text-muted`           | `#696972` | `#a3a3a3`               | Meta, timestamps, placeholders, tool args, reasoning, receded (stored/archived) titles    |
| `--color-accent`               | `#1b4ed8` | `#51a2ff`               | Links, text actions, current-item glyphs                                                  |
| `--color-accent-fill`          | `#1b4ed8` | `#346bf1`               | Filled primary button and the Send button only                                            |
| `--color-on-accent`            | `#ffffff` | `#ffffff`               | Text and glyphs on `--color-accent-fill`                                                  |
| `--color-accent-soft`          | `#e6ebf8` | `#09132b`               | Selected tint: selected menu or palette row, `.on` icon button, drop target               |
| `--color-info`                 | `#0069a8` | `#74d4ff`               | "Working" and "Starting" status (dot + label), running tool dot                           |
| `--color-success`              | `#007a55` | `#00d492`               | "Done" status, tool success, added-line text, ctx meter ok                                |
| `--color-danger`               | `#c10007` | `#ff6467`               | "Failed" status, errors, Stop, removed-line text, bypass mode                             |
| `--color-warning`              | `#ad4700` | `#ffb900`               | "Needs you" status (approval or question waiting), context pressure, attachment warnings  |
| `--color-diff-add-bg`          | `#def4ed` | `#001e14`               | Added-line background in diff blocks                                                      |
| `--color-diff-remove-bg`       | `#fce7e8` | `#2d080a`               | Removed-line background in diff blocks                                                    |
| `--color-focus-ring`           | `#1b4ed8` | `#51a2ff`               | 2px focus outline (same hue as accent, but kept separate so it can change alone)          |
| `--color-overlay`              | `rgba(0,0,0,.32)` | `rgba(0,0,0,.6)` | Scrim behind modal dialogs, the palette and the narrow-screen sidebar                     |

**Origin.** Light mode uses a zinc scale: zinc-25 canvas, zinc-50 sidebar, zinc-100 wells, a zinc-200 hairline, zinc-900 text. Dark mode uses a true-black canvas, `#111` cards, white-at-8% hairlines and neutral-100 text. The accent is oklch(0.488 0.217 264) in light mode. Dark links use blue-400 and the dark fill uses oklch(0.571 0.21 264). Muted text is `#696972`, not zinc-500, which is only 4.1:1 on hover. Light warning is `#ad4700`, and info is sky-700 in light mode. `--color-border-strong` exists because zinc-300 and white-at-11% input borders fall below 3:1.

### Contrast (WCAG 2.x, computed)

AA needs 4.5:1 for text under 18px (or under 14px bold), and 3:1 for large text and for the boundaries of UI components.

| Pair                                          | Light   | Dark    |
| --------------------------------------------- | ------- | ------- |
| text on bg                                    | 17.3:1  | 19.3:1  |
| text on sidebar                               | 17.0:1  | 18.2:1  |
| text on surface                               | 16.1:1  | 18.2:1  |
| text on message                               | 14.9:1  | 15.3:1  |
| text-muted on bg                              | 5.3:1   | 8.3:1   |
| text-muted on sidebar                         | 5.2:1   | 7.8:1   |
| text-muted on surface                         | 4.9:1   | 7.9:1   |
| text-muted on surface-hover (worst row case)  | 4.7:1   | 6.9:1   |
| text-muted on sidebar-row-active              | 5.4:1   | 6.1:1   |
| text-muted on message                         | 4.6:1   | 6.6:1   |
| accent on bg                                  | 6.5:1   | 8.0:1   |
| accent on surface                             | 6.1:1   | 7.5:1   |
| accent on accent-soft                         | 5.6:1   | 7.0:1   |
| on-accent on accent-fill                      | 6.7:1   | 4.7:1   |
| info on sidebar / on surface-hover            | 5.6 / 5.0:1 | 11.9 / 10.4:1 |
| success on bg / on surface-hover              | 5.2 / 4.6:1 | 10.8 / 9.0:1 |
| danger on bg / on surface-hover               | 6.3 / 5.5:1 | 7.3 / 6.0:1 |
| warning on bg / on surface-hover              | 5.6 / 4.9:1 | 12.2 / 10.1:1 |
| success on diff-add-bg                        | 4.7:1   | 9.1:1   |
| danger on diff-remove-bg                      | 5.4:1   | 6.3:1   |
| text on diff-add-bg / diff-remove-bg          | 15.4 / 15.0:1 | 16.1 / 16.7:1 |
| border-strong on bg / on surface-raised       | 3.5 / 3.6:1 | 3.9 / 3.5:1 |
| focus-ring on bg                              | 6.5:1   | 8.0:1   |

Rules that follow:

- Muted text may sit on every surface in the table. It never sits on `--color-accent-soft` or on diff backgrounds; use `--color-text` there.
- Diff lines must not rely on colour alone; always show the `+` / `-` gutter glyph.
- Status is always a dot or glyph plus a text label, never colour alone.
- `--color-border` is decorative (about 1.2:1). Anything interactive that has no other visible cue needs `--color-border-strong`.

## Tokens — Typography

**Families.**

- `--font-ui`: `-apple-system, BlinkMacSystemFont, "Inter Variable", "InterVariable", Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
- `--font-mono`: `"SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace`

Apple platforms render SF Pro, the system font that comes first. Everyone else renders Inter.

- **Inter is self-hosted.** It is a single woff2 (Inter Variable, weight axis 100-900, Latin subset) served by the hub at `/fonts/inter-latin-wght-normal.woff2`. It is never fetched from Google or a CDN.
- **Licence.** Inter is under the SIL Open Font License 1.1. Ship `OFL.txt` next to the woff2, and keep the font's name and copyright.
- **The `@font-face` in the Quick Start** tries `local()` first, uses `font-display: swap`, and is limited to Latin by `unicode-range`. A user who has Inter installed never downloads it. A missing file just falls back to Segoe UI Variable, Segoe UI or system-ui, at the same sizes. The layout does not depend on the font loading.
- **Mono** stays system-only. `ui-monospace` is left out on purpose: some engines map it to a proportional font.

**Weights:** 400 for body text and receded rows, 500 for labels, row titles and emphasis, 600 for headings. Never 700. Tracking is 0 at UI sizes; only the 16px and 20px titles tighten slightly. Use `-webkit-font-smoothing: antialiased` on the body. Counters, durations and `+N −M` use `font-variant-numeric: tabular-nums`.

### Type scale

The scale is centred on 14px. That is the default for prose and rows. 13px is the dense tool-row size, 12px is meta, 11px is micro.

| Role         | Family | Weight  | Size   | Line height | Tracking | Token                | Use                                                         |
| ------------ | ------ | ------- | ------ | ----------- | -------- | -------------------- | ----------------------------------------------------------- |
| display      | UI     | 600     | 20px   | 1.4         | -0.3px   | `--text-display`     | Empty-state title only ("What should we work on?")           |
| title        | UI     | 600     | 16px   | 1.375       | -0.1px   | `--text-title`       | Dialog and palette titles                                    |
| body         | UI     | 400     | 14px   | 1.625       | 0        | `--text-body`        | Assistant prose (markdown), user message, composer input     |
| ui           | UI     | 400/500 | 14px   | 1.43        | 0        | `--text-ui`          | Session titles, project names, buttons, menu and picker rows, top-bar title |
| compact      | UI     | 400     | 13px   | 1.4         | 0        | `--text-compact`     | Status bar, chips, toasts, tool row labels                   |
| meta         | UI     | 400/500 | 12px   | 1.33        | 0        | `--text-meta`        | Row meta line, timestamps, status labels, group headers, hints, +N −M |
| micro        | UI     | 500     | 11px   | 1.45        | 0        | `--text-micro`       | Counts on folders and shelves, kbd hints, jump hints, badges, undo notice |
| code         | Mono   | 400     | 13px   | 1.5         | 0        | `--text-code`        | Code blocks, tool args/results, diffs, terminal              |
| code-inline  | Mono   | 400     | 0.85em | inherit     | 0        | `--text-code-inline` | Inline `code` in prose                                       |

Markdown headings in the transcript do not use `display`. h1 is 16px/600, h2 15px/600, h3 and below 14px/600, all in `--color-text`. Group headers in pickers, menus and sidebar shelves are 12px/500 in `--color-text-muted`. They are never uppercase.

## Tokens — Spacing & Shapes

**Base unit:** 4px. **Density:** compact everywhere. The chrome is tight and the transcript is generous only between turns.

| Token         | Value | Typical use                                                         |
| ------------- | ----- | ------------------------------------------------------------------- |
| `--space-1`   | 4px   | Icon-to-label gap, chip inner gap (sidebar rows sit 1px apart: see Sidebar spacing) |
| `--space-2`   | 8px   | Sidebar inset, gap between header controls, dense row padding-y     |
| `--space-3`   | 12px  | Row padding-x (sidebar rows use 10px: `--space-2` + 2px), card padding (compact), gap between sidebar folders |
| `--space-4`   | 16px  | Card padding, composer padding, transcript gutter on mobile         |
| `--space-5`   | 20px  | Gap between unrelated blocks in chrome                              |
| `--space-6`   | 24px  | Gap between turns (user message to the next response)               |
| `--space-8`   | 32px  | Transcript side gutter (desktop), dialog padding                    |
| `--space-12`  | 48px  | Empty-state vertical rhythm                                         |

**Layout constants:**

- Sidebar: 256px default (`--size-sidebar`). The user can drag it between 208px and the viewport width minus 640px.
- Transcript and composer column: max 736px (`--size-column`).
- Right panel: 520px default, 300px minimum.
- Top bar: 52px (`--size-topbar`).
- Hit targets: at least 28px high (`--size-row`). Header controls and primary buttons are 32px (`--size-hit`). Touch targets are 44px via `@media (pointer: coarse)`.

### Border radius

| Token             | Value  | Element                                                                       |
| ----------------- | ------ | ----------------------------------------------------------------------------- |
| `--radius-badge`  | 4px    | Language label, inline `code`, kbd keys, count badges                          |
| `--radius-row`    | 6px    | Sidebar rows (session, project folder, shelf header), tool rows, menu items     |
| `--radius-control`| 8px    | Buttons, icon buttons, inputs, code blocks, popovers, menus, toasts             |
| `--radius-card`   | 16px   | User bubble, composer, dialogs, the command palette, plan and ask cards         |
| `--radius-hero`   | 20px   | The empty-state card only. Nowhere else.                                       |
| `--radius-pill`   | 9999px | The Send/Stop button, chips (queued, attachment), switches, the jump-to-latest button |

### Elevation

The chrome is flat: no shadows on the sidebar, rows, cards, the composer, the transcript or the panels. These are separated by surface steps plus a 1px `--color-border` hairline. The one exception is anything floating above the page: popovers, menus, the command palette, toasts and the jump-to-latest button. These use `--color-surface-raised`, a 1px `--color-border`, and `--shadow-popover` (a soft drop that stays below the hairline in dark mode). Modals also add `--color-overlay`. `0 0 0 1px` rings (the active sidebar row, focus) are outlines, not elevation.

**Focus.** Every interactive element gets `outline: 2px solid var(--color-focus-ring); outline-offset: 2px` on `:focus-visible`. Rows in the sidebar use `outline-offset: -2px` (an inset ring) so it is not clipped. Never remove the outline without a replacement. Inputs inside the composer show focus on the composer's border (it becomes `--color-focus-ring`), not with a second ring.

### Motion

- Durations: `--motion-fast: 150ms` (hover, press, chip, tooltip, chevron) and `--motion-base: 200ms` (popover, palette, toast, disclosure, undo notice fade). Easing: `--ease-out: cubic-bezier(0.2, 0, 0, 1)`. Nothing runs longer than 200ms except the looping pulse.
- Animate only `opacity` and `transform` (translateY up to 4px, scale from .98). Never animate layout properties in the transcript or the sidebar list.
- Running pulse (status dot, tool dot, busy spinner): 2s, infinite, opacity 1 → .4 → 1.
- Under `@media (prefers-reduced-motion: reduce)`, every transition and animation is set to `0.01ms`. The pulse becomes a static dot plus its text label, smooth scrolling is turned off, and the jump-to-latest button jumps instantly.

## Components

All components use tokens only. A "row" has a 6px radius, a "control" 8px, a "card" 16px, a "pill" 9999px.

### App shell

- **Sidebar.** `--color-sidebar`, with a `border-right: 1px solid --color-border`. Its width is `--size-sidebar`, resizable (see Sidebar resize rail).
- **Top bar.** 52px, on `--color-bg`, with a bottom hairline; the sidebar's logo row is the same 52px, so the two line up. It shows a breadcrumb in 14px: the project in muted text, a muted `›` with 8px either side, then the session title in `--color-text` at 500 (each part truncates on its own). After the title, 12px from it, sits the **checkout chip**: a 24px pill with a 1px `--color-border` outline, a 12px branch glyph, the branch name in 12px muted mono (middle-truncated past 36 characters) and the uncommitted `+N` / `−M` in `--color-success` / `--color-danger` (mono, tabular). A worktree session shows its own branch. The chip is absent outside a git checkout.
- **Right panel.** `--color-bg` with a left hairline and a tab strip on `--color-surface`. It is resizable via a 4px grip that shows a 2px `--color-border-strong` line on hover.
- **Narrow screens (≤1000px).** The sidebar overlays the chat: hairline edge, no shadow, `--color-overlay` scrim behind it. Picking a session closes it.

### Sidebar spacing

One system for every part of the sidebar. The list is a tree: projects are 32px headers, sessions are 36px rows nested under them, and the indent is what tells them apart, together with the weight and the icon.

| Measure                     | Value | Where                                                                                     |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| List inset (`--sb-inset`)   | 8px   | Left and right of the search row, the list, the undo notice and the footer's buttons       |
| Row padding (`--sb-pad`)    | 10px  | Left padding of every row, header and section label; also the icon-to-name gap in a folder header |
| Title indent (`--sb-indent`)| 36px  | 10px padding + 16px icon + 10px gap. Session titles start here, exactly under their folder's name |
| Folder header               | 32px  | `--size-hit`                                                                              |
| Session row (`--sb-row`)    | 36px  | Every session row on every shelf, live or stored, current or not: one line, one height     |
| Between rows                | 1px   | Rows in a folder and on a shelf                                                           |
| Between folders (`--sb-group-gap`) | 12px | The gap above every folder but the first                                                  |
| Section label               | 28px  | Pinned, Projects, Archived                                                                 |
| Shelf rows                  | 36px  | The project's 16px icon sits in the indent (at 10px), so the title still starts at 36px    |
| Header                      | 52px + 40px | The logo row (as tall as the top bar), then the 32px search row with 8px below it   |
| Footer                      | 44px  | Name and version on the left, the shortcuts button on the right; no rule above it         |

Text tiers: folder names 14px/500 `--color-text`; live and unread session titles 14px/500 `--color-text`; stored and seen session titles recede to 14px/400 `--color-text-muted` (they return to `--color-text` on hover, focus and when current); section labels, times, counts and status labels 12px; icons 16px in headers and lead positions, 12px for inline marks (pin, worktree, draft), 14px inside 24px row action buttons.

### Sidebar header

- **Logo row.** 52px, padding 0 8px 0 18px: the SMOL block logo (required branding, `--color-accent`, mono, 5px cells, about 34px tall), then a 28px "Hide sidebar" icon button (panel glyph) at the right.
- **Search row.** One 32px row with 8px insets and 8px below it. A search field fills the space. It has no border: a 16px muted search glyph, 8px gap, and the placeholder "Search". On hover or focus it gets a `--color-surface-hover` fill; focus adds a 2px inset `--color-focus-ring`.
- Then three 28px icon buttons, 2px apart: Filter by project, Add project (folder-plus) and New session (pen-square). Each shows its tooltip with the shortcut. An active filter shows the filter button `.on`, and a 28px bar under the search row ("Only <project> · Show all", on `--color-surface-hover`).

When the field has a query, the list is replaced by results: matching titles first, then sessions whose transcripts match. Results use the shelf-row geometry (project icon at 10px, title at 36px) plus a second 18px line at the title indent: the project's name in 12px muted and, for a transcript match, the snippet after a ·, with the match in `--color-text` at 500. The highlighted result is `--color-accent-soft`. ↑ and ↓ move through the results, Enter opens one, Esc clears the query. Empty results show a centred 12px muted "No sessions found".

### Project list (folders)

Sessions are grouped under their project, and projects are ordered: pinned first, then by most recent activity.

- **The folder header** is a 32px row (`--radius-row`, padding 0 6px 0 10px, gaps 10px). It shows a 16px project icon, the name in 14px/500 `--color-text` (truncated), a 12px muted pin glyph if the project is pinned, and a trailing 12px chevron in a 16px box (−90° when collapsed, 150ms rotate). On hover it fills with `--color-surface-hover`.
- **On hover or focus** a 24px "New session in <project>" pen button appears just left of the chevron. It is always visible on touch.
- **A collapsed folder** also shows its session count in 12px muted tabular figures, plus one 6px status dot that summarises the hidden sessions. The most urgent wins: Needs you (`--color-warning`), then Failed (`--color-danger`), then Done/unread (`--color-success`), then Working (`--color-info`, pulsing). The dot has a visually hidden label, for example ", needs you".
- **Spacing:** 12px between folders; the folder's sessions follow 1px under its header.
- **A folder with no sessions** shows one muted 36px "New session" row at the title indent.
- **Project icon:** the project's favicon if the hub found one. Otherwise a 16px monogram tile (`--radius-badge`, one letter, 10px/600) whose tint comes from a hash of the path, using the status hues at 15% over the sidebar with the full hue for the letter.
- **Right-click** (or Shift+F10 / the Menu key) opens the project menu: New session, New session on a branch, Pin/Unpin project, Show only this project, Collapse/Expand, Copy path, Remove from list.

### Session (thread) rows

Every session is one 36px line (`--radius-row`), 1px apart, whatever its state, so the list keeps one rhythm. Inside a folder the row's padding is 0 10px 0 36px, so the title sits under the folder's name. Left to right:

1. (shelf and search rows only) the project's 16px icon at 10px, with the title still at 36px;
2. an unsent-draft mark (12px muted pen) if there is one;
3. the title, 14px, truncated: 500 `--color-text` for live and unread sessions; 400 `--color-text-muted` for stored and seen ones (they recede);
4. a 12px muted pin mark if the session is pinned (outside the Pinned shelf), and a 12px muted branch mark if it runs in its own worktree (the tooltip names the branch);
5. the status slot at the right edge, 12px.

The model is in the row's tooltip, and the branch with `+N −M` is in the top bar's checkout chip: they are the same for every session of a checkout, so rows do not repeat them.

States:

- **Rest:** transparent background.
- **Hover:** `--color-surface-hover`.
- **Current session:** `--color-sidebar-row-active` with a `0 0 0 1px` inset `--color-sidebar-row-ring` (light only). The title is `--color-text`, with `aria-current="page"`.
- **Focus:** a 2px inset `--color-focus-ring`.

Status slot (12px/500, label + 6px dot, never colour alone; the row keeps it short so the title has room):

| State                         | Label      | Colour            | Dot              |
| ----------------------------- | ---------- | ----------------- | ---------------- |
| starting                      | Starting   | `--color-info`    | pulse            |
| busy                          | Working    | `--color-info`    | pulse; the slot's tooltip says how long ("Working for 1m 12s") |
| waiting (approval or question)| Needs you  | `--color-warning` | static           |
| error                         | Failed     | `--color-danger`  | static           |
| idle, finished since last seen| Done       | `--color-success` | static           |
| idle, seen / stored           | (relative time: now, 5m, 3h, 2d, 3w, 4mo, 1y) | `--color-text-muted`, 400, tabular | none |

Hover and focus swap the status slot for row actions: 24px icon buttons (14px glyphs) for archive (or restore) and the more menu. They are always visible on touch. While Alt is held, a jump hint takes the slot instead.

**Interaction:**

- Click or Enter opens the session; a stored session resumes.
- Double-click or F2 renames inline. The input is 26px, 14px/500 on `--color-surface-raised` with a 1px `--color-border-strong` border and `--radius-badge` corners, its text kept where the title was. Enter saves, Esc cancels, and blur saves.
- Right-click opens the session menu: Pin/Unpin, Rename, Mark unread, Copy path, Copy session id, New session in this project, New session on a branch, Close session (live only), Archive, Delete. Delete is in `--color-danger`, below a separator.

There are no `alert`, `confirm` or `prompt` dialogs.

### Sidebar shelves (Pinned, Archived)

Section labels are 28px rows, padding 0 10px: the name in 12px/500 `--color-text-muted`, then a 1px `--color-border` rule to the right edge. Never uppercase.

**Pinned** sits above the folders: its "Pinned" label, then its rows (shelf rows, with the project icon), then 12px, then a "Projects" label over the folders. Without pinned sessions neither label is drawn.

**Archived** sits at the bottom of the list (`margin-top: auto`, 20px above it). Its header is a 28px button with "Archived" in 12px/500 muted, the count in 12px tabular and a chevron, all muted; hover fills it with `--color-surface-hover`. It is collapsed by default, and the collapsed state is remembered. Open, it shows 10 shelf rows (receded), then a "Show N more" text button in 12px `--color-accent` at the title indent.

### Undo notice

Archive and delete happen immediately. A one-line notice then appears above the sidebar footer: a 32px `--color-surface-hover` row (`--radius-row`, 8px insets, padding 0 10px) with 12px text such as "Archived 'Fix login'" and an "Undo" text button in `--color-accent`. It stays 6s, Ctrl+Z also triggers it, and it fades in and out over 200ms with `role="status"`. Delete removes the session for good only once the notice expires.

### Context menus

Floating (`--color-surface-raised`, 1px `--color-border`, `--radius-control`, `--shadow-popover`), 224px to 320px wide, 4px padding, items 1px apart. Items are 32px rows (`--radius-row`, padding 0 8px 0 10px) in 14px; hover and keyboard focus fill with `--color-surface-hover`. Shortcuts are 11px mono kbd keys on `--color-surface` at the right. Separators are 1px `--color-border` with 4px above and below, inset 10px. Danger items use `--color-danger`.

### Sidebar resize rail

A 4px invisible hit area on the sidebar's right edge (`cursor: col-resize`). On hover it shows a 2px `--color-border-strong` line. Dragging resizes the sidebar between 208px and `viewport − 640px`, double-click resets it to 256px, and the width is saved in localStorage. Ctrl+B collapses the sidebar off-canvas. The 28px expand button (the same panel glyph) then sits in the top bar.

### Keyboard (sidebar)

- Ctrl+B: toggle the sidebar.
- Alt+N: new session in the current project.
- Alt+↑ / Alt+↓: previous or next session in list order.
- Alt+1…9: jump to the Nth visible session. While Alt is held, each row shows an 18px 11px-mono `--radius-badge` kbd hint in its status slot.
- F2: rename.
- Ctrl+K → "Add project", "Search sessions".

Avoid Ctrl+N, Ctrl+T, Ctrl+W and Ctrl+1…9, which the browser owns.

### Empty states

- **No projects.** A centred column (max-width 512px, padding 48px 32px) on `--color-bg`. It holds the SMOL logo (required branding, accent colour, mono), the display title "What should we work on?", a 14px muted line "Add a project folder to start your first session.", and a primary "Add project" button. Below these is a "Recent" list of 32px rows: name on the left, path in muted mono 12px on the right. The `--radius-hero` card is optional here.
- **No session selected.** The same column with the logo, "Pick a session to continue" and a ghost "New session" button.
- **A fresh session.** Until its first user or assistant message, a session shows the SMOL logo (11px cells, `--color-accent`) centred about 12vh from the top, then "What should we work on?" in the display style, 16px below it. This is a state of the session (the log's `.fresh` class), not an empty log: notes that arrive first, such as a model warning or "loading the model…", appear centred under the question and do not hide the logo. The first user message, reply, thought or tool call ends it.
- **Sidebar with no projects.** A 12px muted hint, "No projects yet", centred with 24px above and below.

The logo must remain on first load and on an empty session.

### Buttons and icon buttons

- **Primary:** `--radius-control`, `--color-accent-fill` background, `--color-on-accent` text, 14px/500, height 32px (28px when compact), padding 0 12px. Hover: `filter: brightness(.94)`. Use one per view region.
- **Ghost / secondary:** `--radius-control`, transparent, 1px `--color-border-strong`, `--color-text`. Hover background `--color-surface-hover`.
- **Danger** (destructive confirm): the ghost shape with text and border in `--color-danger`.
- **Icon button:** 28px square (24px inside rows), `--radius-control`, transparent, 16px glyph (14px inside rows) in `--color-text-muted`. Hover: `--color-surface-hover` with the glyph in `--color-text`. The `.on` state is a `--color-accent-soft` background with an `--color-accent` glyph. Lucide-style strokes are 1.75.
- **Disabled:** 64% opacity, `cursor: not-allowed`.

### Inputs

`--color-surface-raised`, a 1px `--color-border-strong` border, `--radius-control`, 14px, height 32px, padding 0 10px. The placeholder is `--color-text-muted`. Focus: the border becomes `--color-focus-ring`, plus the 2px ring.

### Composer

- A card (`--radius-card`) on `--color-surface-raised`, with a 1px `--color-border` that becomes `--color-border-strong` on hover and `--color-focus-ring` on focus-within. No shadow. Padding 12px 16px.
- The textarea is 14px, transparent, at least 2 rows.
- Below the textarea: a status row in 13px with ghost-text buttons (mode, model, effort, context meter). At the right sits the round 32px Send button (`--radius-pill`, `--color-accent-fill`, arrow glyph). While the agent runs it is replaced by a round Stop button (danger ghost).
- Drag-over turns the border `--color-accent`, with no glow. Attachment chips sit above the textarea, inside the card.

### Queued-message chips

These are messages typed while the agent is busy.

- They stack above the composer card, in the same column width, with a 4px gap.
- Each chip is a pill on `--color-surface`, with a 1px `--color-border`. It holds:
  - a leading 12px muted "Queued" label;
  - 13px text, truncated to one line (max 60ch);
  - a trailing 20px "×" icon button with `aria-label="Remove queued message"`.
- The chip that will be sent next uses `--color-text`; later chips use `--color-text-muted`.
- A new chip enters with a 150ms fade and `translateY(4px)`.

### Jump-to-latest button

Centred above the composer (`bottom: calc(100% + 8px)`). A pill on `--color-surface-raised`, with a 1px `--color-border` and `--shadow-popover`. It reads "↓ Latest" in 13px, plus an unread count when new content arrived. It fades in and out over 150ms and is hidden when the view is at the bottom. `aria-label="Scroll to latest message"`.

### User message

A `--color-message` card (`--radius-card`), no border, 14px/1.625, padding 10px 16px, `white-space: pre-wrap`, max-width 80% and right-aligned. 24px of space above and below. Attachment thumbnails use 8px corners and a hairline; file chips are pills.

### Assistant prose (markdown)

- 14px/1.625, `--color-text`, no container, in the 736px column. Paragraph margin 12px, list item gap 4px.
- Links are `--color-accent`. In running prose they are always underlined (1px, offset 2px), so colour is not the only cue.
- Blockquote: a 2px `--color-border-strong` rule on the left, muted text.
- Tables: 1px hairlines, 13px, the header row on `--color-surface`.

### Code blocks (language label + copy)

- `--color-surface`, with a 1px `--color-border` and `--radius-control` corners. The code is `--text-code` and scrolls horizontally when needed.
- A 28px header strip with a hairline under it holds:
  - on the left, the language label, 12px `--color-text-muted`, lowercase (e.g. `ts`);
  - on the right, a **Copy** icon button. It becomes "Copied" with a check for 1.5s and announces that through `aria-live="polite"`.
- The header controls are always visible on touch and on keyboard focus. For mouse users they fade in on hover.
- Inline code: a `--color-surface` background, `--radius-badge` corners, `--text-code-inline`, `--color-text` (not coloured).

### Diff blocks (red/green with +N −M)

A code block variant.

- **Header:** the file path in 12px mono `--color-text`, then `+N` in `--color-success` and `−M` in `--color-danger` (12px/500, tabular), then Copy.
- **Lines:** `--text-code` with a 20px line height. Added lines sit on `--color-diff-add-bg`, removed lines on `--color-diff-remove-bg`, context lines on `--color-surface`.
- **Gutter:** 20px wide, showing `+` / `−` in the colours above. The line text stays `--color-text`.
- **Hunk header (`@@`):** `--color-surface-hover`, muted text.
- **Long diffs** collapse after 24 lines behind a ghost link, "Show N more lines".

### Tool rows

One dense line per call: `[status glyph] name   args…   duration`. The row uses `--radius-row`, is 28px high with 8px side padding, and is set in 13px. The glyph sits in a 14px column 8px in from the prose edge; the reasoning summary's chevron and the busy line's pulsing dot use the same column, so every transcript glyph lines up and every label starts 30px in.

- **Parts:** name in `--color-text` at 500; args in 12px mono `--color-text-muted`, truncated with an ellipsis; duration on the right in 12px muted tabular figures.
- **Hover:** `--color-surface-hover`.
- **Disclosure:** the row is a `<details>`, and its chevron rotates over 150ms.

States:

- **Running:** a 6px `--color-info` dot with the pulse, plus a visually hidden "running". The duration counts up live.
- **Success:** `✓` in `--color-success`.
- **Failed:** `✗` in `--color-danger`. The row opens by itself, and the name stays `--color-text`.
- **Expanded result:** a body on `--color-surface` with `--radius-control` corners, mono 13px, max-height 280px with scrolling, indented 20px. Error bodies add a 2px `--color-danger` rule on the left.
- **Grouped row ("Explored · 3 reads"):** consecutive read, search and list calls collapse into one row. It shows a muted "Explored" label, `·`, a count summary ("3 reads, 2 searches") and a chevron. Expanding it lists the child tool rows, indented 16px. If any child is running, the group shows the pulse; if any child failed, the group shows `✗`.

### Reasoning disclosure ("thought for Ns")

- A `<details>` in `--color-text-muted`, 12px. It never uses the accent colour.
- **Summary:** chevron plus "Thinking…" with the pulse while streaming, then "Thought for 4s" when done.
- **Closed by default.** While streaming, the summary shows a one-line live preview, cut off with an ellipsis.
- **Open body:** 13px muted text, a 2px `--color-border` rule on the left (under the chevron), 12px padding on the left, max-height 320px with scrolling.

### Plan card

A card with a hairline and no fill, 13px. Steps:

- done: `--color-success` ✓, `--color-text-muted` text with a strike-through;
- current: `▶`, `--color-text` at 500;
- todo: muted `○`.

### Approval / question box (ask)

- A card on `--color-surface-raised` with a 2px `--color-warning` rule on the left. This is the only place warning is used as a rule.
- Title 14px/600. The command appears in a mono block on `--color-surface`.
- Actions: "Allow" is the primary button, "Deny" is ghost, and "Always allow this program" is a ghost text button.
- Options are a list of rows (`--radius-row`). The current option has a `✓` and `--color-success` text at 500.

### Command palette (Ctrl+K)

- **Container:** a modal on `--color-overlay`. The card is `--color-surface-raised`, `--radius-card`, a 1px hairline and `--shadow-popover`. Width min(560px, 92vw), placed 15vh from the top. It enters with a 200ms fade and a scale from .98.
- **Search input:** at the top, 16px, borderless, with a hairline under it. `aria-label="Search commands"`.
- **Results:** grouped lists with 12px group headers. Rows are 32px, `--radius-row`, 14px, with the label on the left. On the right is a muted description or a shortcut (a `kbd` with `--radius-badge`, 11px mono). The selected row is `--color-accent-soft` and carries `aria-selected`.
- **"Add project":** a typed path with a live folder listing. Tab completes the highlighted folder, `..` goes up, and Enter adds the folder.
- **Footer:** a 12px muted hint row ("↑↓ navigate · Enter run · Esc close").
- **Semantics:** role `dialog` with listbox semantics. Focus is trapped, and Esc closes the palette and restores focus.

### Picker popovers (model, mode, effort, workspace) with groups and ★ stars

- **Container:** a popover anchored to its trigger. It opens upward from the composer status row with an 8px gap. `--color-surface-raised`, `--radius-control`, a 1px hairline, `--shadow-popover`. Min-width 260px, max-height 360px with scrolling, padding 4px.
- **Group header:** 12px/500 muted, padding 8px 12px 4px, sticky.
- **Item:** a 32px row with `--radius-row`. A 14px label with optional 12px muted meta (size, host). The current item is marked `✓` in `--color-accent`.
- **★ star button:** a trailing 24px icon button. Unstarred it is an outline star in `--color-text-muted`; starred it is a filled star in `--color-warning`. It has `aria-pressed` and `aria-label="Star <name>"`. Starred items also appear in a pinned "Starred" group at the top.
- **Keyboard:** Esc and a click outside close the popover. Arrow keys move. Typing filters the list once it has more than 8 items.

### @-mention and slash menus

- **Container:** the same chrome as the picker popovers, anchored above the textarea and as wide as the composer. No footer.
- **Slash rows:** `/name` in 14px/500 `--color-text`, the description in 13px muted.
- **@-mention rows:** a file icon or glyph, then the path in 13px mono, with the folder part muted and the file name in `--color-text`.
- **Selected row:** `--color-accent-soft`.
- **Keys:** Tab completes, Enter commits, Esc dismisses.
- **Empty state:** a single muted row, "No matches".

### Toasts

- **Placement:** a stack at the bottom centre, above the composer area (16px from the bottom, 8px gap).
- **Box:** `--color-surface-raised`, `--radius-control`, a 1px hairline, `--shadow-popover`. 13px text, padding 10px 14px, max-width 420px.
- **Leading glyph:** ✓ for success, ✗ for danger, ! for warning. Only the glyph takes the status colour; the text stays `--color-text`.
- **Action:** optional, as a text link in `--color-accent`.
- **Timing:** they enter with a 200ms fade and `translateY(4px)`. They close themselves after 4s, or 8s when they have an action, and pause while hovered or focused.
- **Semantics:** the container is `role="status"` `aria-live="polite"`; errors use `role="alert"`. A close "×" appears on keyboard focus.

### Desktop notification toggle

A switch row in the settings/user menu, plus a bell icon button in the top bar.

- **Switch:** a 36×20px pill track. Off, the track is `--color-border-strong`; on, it is `--color-accent-fill`. The 16px knob is `--color-bg` and slides over 150ms.
- **Text:** the label is 14px, "Desktop notifications". The helper text is 12px muted: "When a session needs you or finishes while this tab is in the background".
- **Permission denied:** the switch is disabled, and the helper text turns `--color-warning`: "Blocked by the browser. Allow notifications in site settings."
- **Semantics:** `role="switch"` with `aria-checked`. When notifications are on, the bell uses the `.on` icon-button state.

### Right panel: browser and terminal tabs

- **Tabs:** 28px tall, with `--radius-control` corners, in a strip that scrolls sideways. The active tab is `--color-surface-raised` with a hairline and `--color-text`. A close `×` appears on hover or focus.
- **Browser bar:** a URL input (see Inputs) plus icon buttons.
- **Terminal:** `--color-bg`, mono 13px/1.4. The prompt is `--color-accent`.
- **ANSI colours** map to tokens: red `--color-danger`, green `--color-success`, yellow `--color-warning`, blue `--color-accent`, cyan `--color-info`, grey `--color-text-muted`. Bright variants use the same hues. 256-colour and truecolor codes are ignored.

### Status bar chips and context meter

- **Chips:** 13px ghost text buttons with `--radius-control` corners.
- **Mode:** Edit is `--color-text`, Read-only is `--color-text-muted`, Bypass is `--color-danger`.
- **Context meter:** a 40×6px track in `--color-border` with a `--color-text-muted` fill. From 75% the fill and the percentage turn `--color-warning`; from 95% they turn `--color-danger`. The number is always shown.

### Status lines (turn end, warning, error)

- **Turn end:** 12px muted text with a hairline above it, "■ Done in 12s".
- **Warning:** `--color-warning` text with a `!` glyph.
- **Error:** `--color-danger` text with a `✗` glyph. It wraps and can be selected.

## Do's and Don'ts

### Do
- Use only tokens, from one value set with a light and a dark column. Test both themes before merging.
- Separate layers with the lightness steps (`bg`, `sidebar`, `surface`, `surface-raised`) and 1px `--color-border` hairlines.
- Keep it dense:
  - 14px prose and row titles, 12px meta;
  - 28px tool rows, 32px folder headers, 36px session rows (one line, every state);
  - 1px between sidebar rows, 12px between folders, 24px between turns;
  - session titles indented 36px, under their folder's name.
- Save `--color-accent` / `--color-accent-fill` for links, focus, the current selection and primary actions. Use one primary button per region.
- Give every status a dot or glyph and a visible label, as in the sidebar status slot and tool rows.
- Show sidebar row actions on hover and on keyboard focus, and always on touch. Every row action also has a context-menu entry.
- Use ease-out at 150–200ms on opacity and transform, and honour `prefers-reduced-motion`.
- Keep a visible `:focus-visible` ring on every interactive element. Give icon-only buttons an `aria-label`. Use `aria-live` for toasts, the undo notice and the copy confirmation.
- Use monospace only for code, paths, commands, diffs, the terminal and kbd hints.

### Don't
- No gradients, no noise grain, no glow on drag-over or focus.
- No shadows on non-floating chrome: sidebar, rows, cards, the composer, panels.
- Don't use the accent blue for decoration, for a status (working is `--color-info`), or for headings.
- Don't put muted text on `--color-accent-soft` or on diff backgrounds; use `--color-text`.
- Don't hardcode hex values or add `@media (prefers-color-scheme)` overrides inside components. Only the token blocks differ by theme.
- Don't load fonts from Google Fonts or any CDN. Only the self-hosted Inter woff2 or system fonts.
- Don't use `alert()`, `confirm()` or `prompt()`. Use inline rename, menus and the undo notice.
- Don't use the hero radius outside the empty-state card, use pills for ordinary buttons, or use 700 weights.
- Don't use all-caps group headers, emoji as UI glyphs other than the ★ star, or decorative animation.
- Don't remove the SMOL logo from the first-load and empty-session views, and don't tie the fresh-session logo to an empty log: a note must not hide it.
- Don't give one sidebar row a different height or layout from the others (no multi-line cards).

## Agent Prompt Guide

Quick token reference (resolve via CSS variables, not literals):

- Backgrounds: `--color-bg` (canvas), `--color-sidebar`, `--color-surface` (code, tool bodies, wells), `--color-surface-raised` (composer, popovers, dialogs, toasts), `--color-surface-hover`, `--color-sidebar-row-active`, `--color-message` (user bubble), `--color-accent-soft`
- Text: `--color-text`, `--color-text-muted`. Links and current-item glyphs: `--color-accent`. Primary button and Send: `--color-accent-fill` + `--color-on-accent`
- Status: `--color-info` (working), `--color-success` (done), `--color-danger` (failed), `--color-warning` (needs you). Diff fills: `--color-diff-add-bg`, `--color-diff-remove-bg`
- Lines: `--color-border` (hairline), `--color-border-strong` (controls), focus `--color-focus-ring`. Floating layers only: `--shadow-popover`
- Radii: `--radius-badge` 4, `--radius-row` 6, `--radius-control` 8, `--radius-card` 16, `--radius-hero` 20 (empty state only), `--radius-pill` 9999
- Type: `--font-ui` (SF Pro / self-hosted Inter), `--font-mono`; `--text-body` 14, `--text-ui` 14, `--text-compact` 13, `--text-meta` 12, `--text-micro` 11, `--text-code` 13
- Motion: `--motion-fast` 150ms, `--motion-base` 200ms, `--ease-out`

Example prompts:
- "Restyle the sidebar as project folders. 32px folder rows have a 16px icon, a 14px/500 name and a chevron. Collapsed, they show a 12px count and the most urgent status dot. Session rows are one 36px line each, titles indented 36px to the folder name, the status or relative time at the right; stored sessions recede to 400 muted. Folders are 12px apart, rows 1px. The current row is `--color-sidebar-row-active` with an inset `--color-sidebar-row-ring`. The branch and `+N −M` go in the top bar's checkout chip."
- "Add sidebar search: a borderless 32px field with a search glyph. Results show title matches first, then content matches with a muted snippet. ↑↓ and Enter navigate, Esc clears."
- "Add a session context menu (Pin, Rename, Mark unread, Copy path, New session in this project, Archive, Delete). Popover chrome is `--radius-control` with a hairline and `--shadow-popover`. Rename is inline. Archive and delete show the undo notice; no confirm dialogs."
- "Build a Ctrl+K palette: a `--color-surface-raised` card, `--radius-card`, hairline, `--shadow-popover`, `--color-overlay` scrim. Grouped 32px rows with 12px muted headers and `--color-accent-soft` selection. A 200ms fade/scale-in that is turned off under reduced motion."

## Quick Start

Paste these blocks into the page stylesheet. Components read only `var(--…)`, and the dark block overrides colours only. The `@font-face` is safe to paste before the hub serves the file: until it does, browsers fall back to the system stack.

```css
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: local("Inter Variable"), local("InterVariable"),
    url("/fonts/inter-latin-wght-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191,
    U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  color-scheme: light dark;

  /* Colors (light) */
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

  /* Typography */
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
  --tracking-body: 0;
  --tracking-ui: 0;
  --tracking-compact: 0;
  --tracking-meta: 0;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;

  /* Spacing (4px base) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  /* Layout */
  --size-sidebar: 256px;
  --size-sidebar-min: 208px;
  --size-column: 736px;
  --size-topbar: 52px;
  --size-row: 28px;
  --size-hit: 32px;

  /* Radii */
  --radius-badge: 4px;
  --radius-row: 6px;
  --radius-control: 8px;
  --radius-card: 16px;
  --radius-hero: 20px;
  --radius-pill: 9999px;

  /* Elevation: hairlines; one soft shadow for floating layers only */
  --shadow-none: none;
  --hairline: 1px solid var(--color-border);
  --shadow-popover: 0 16px 40px -18px rgba(0, 0, 0, 0.35);

  /* Motion */
  --motion-fast: 150ms;
  --motion-base: 200ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
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

body {
  font-family: var(--font-ui);
  font-size: var(--text-ui);
  line-height: var(--leading-ui);
  color: var(--color-text);
  background: var(--color-bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}
```

**Serving the font (hub side, no dependency).**

- Check in `assets/fonts/inter-latin-wght-normal.woff2` (Inter Variable, weight axis, Latin subset, about 50 KB) plus its `OFL.txt`. Add `assets` to `package.json` `files`.
- Serve `GET /fonts/inter-latin-wght-normal.woff2` with `content-type: font/woff2` and `cache-control: public, max-age=31536000, immutable`.
- Exempt this one path from the `?k=` token check. It is a public font, and CSS `url()` cannot carry the token.
- If the file is absent, return 404. The stack then falls back cleanly.

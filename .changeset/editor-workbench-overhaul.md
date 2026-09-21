---
"cognia-next": minor
---

Rebuilt the built-in project editor around a real workbench: a collapsible activity-rail sidebar with resizable Files/Search panels, breadcrumbs with per-directory navigation, and a status bar showing branch, diagnostics, cursor position, file size, EOL and language. Tabs gained preview/pin semantics, middle-click close, drag reorder, overflow and close-others/right/all menus. The file tree now shows Git decorations, collapse-all, reveal-active-file, drag-to-move, new-file templates and copy-path actions, and project search adds regex/case toggles with live results. Quick Open (Cmd/Ctrl+P) fuzzy-searches the workspace, and binary or oversized files open an honest fallback pane (with image previews where the host can read raw bytes) instead of a dead editor. Monaco now uses real per-file language detection across the bundled grammars, and the whole surface adapts to mobile with a bottom navigation and full-screen panels.

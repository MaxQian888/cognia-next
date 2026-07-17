---
"cognia-next": patch
---

Fix TUI colour-theme switching being ineffective. In scrollback mode the committed transcript and welcome banner live inside Ink's `<Static>`, which freezes already-printed rows — so `/theme` (and the settings-panel theme cycle and custom-theme editor) recoloured only *new* cells while the whole visible history kept its old palette, making the switch look like a no-op. Applying a theme now clears the screen and re-prints the transcript with the new palette (fullscreen already recolours live, so it's skipped there).

Also make the `codex` reuse theme actually resemble Codex out of the box. When `~/.codex/config.toml` has no explicit `tui.theme` (the common case), the reuse fell back to Cognia's warm default palette, which looks nothing like Codex. It now mirrors Codex's own behaviour — a terminal-neutral ANSI UI (cyan accent, matching `codex-rs/tui/src/style.rs`) with `catppuccin-mocha` code-block highlighting, Codex's dark-terminal default — and the light `catppuccin-latte` variant is now mapped too.

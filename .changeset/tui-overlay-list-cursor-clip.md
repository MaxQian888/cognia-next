---
"cognia-next": patch
---

Fix the cursor disappearing when scrolling long lists in the terminal agent (TUI). Modal picker overlays like `/provider` and `/model` reserved rows for their border, title, and footer, but not for the two `↑/↓ N more` scroll-hint lines the list draws while scrolling — so a long list built a box 1–2 rows taller than the terminal, the list got squeezed, and the highlighted row was clipped off-screen as you scrolled down. The overlay row budget now accounts for those scroll-hint rows (plus the fixed banner in fullscreen and the status/mascot/footer beneath it), so long lists scroll and keep the highlighted row visible on any terminal size.

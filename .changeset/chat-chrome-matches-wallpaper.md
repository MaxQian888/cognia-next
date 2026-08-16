---
"cognia-next": patch
---

Fix the chat top bar and conversation list reading as opaque slabs next to a chat pane that shows your wallpaper. The header now opts into the same wallpaper-aware translucent surface as the composer, and the conversation rail carries a single tint instead of stacking a sidebar tint under a gradient that painted over the wallpaper — so the chrome and the message area finally match. Both still go fully opaque under `prefers-reduced-transparency`, and nothing changes when no wallpaper is set.

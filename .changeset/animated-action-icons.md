---
"cognia-next": patch
---

Action icons across the app now animate on interaction instead of sitting static. Copy, download, play/pause, bookmark, bell, heart and the other repeated action glyphs are drawn from a shared animated icon set and rendered through one `AnimatedActionIcon` wrapper, so a copy button confirms itself by morphing to a check rather than swapping in a different icon, and play/pause transitions rather than cutting. The surfaces covered are the chat renderers (code, diff, image, audio, video, math, mermaid), message actions and the conversation minimap, the pet action grid, the TTS now-playing bar, share panels, the notification bell, and the mobile chat, goals and command-history screens. Motion is skipped under `prefers-reduced-motion`.

---
"cognia-next": patch
---

Restyle Sonner toasts with a status accent rail: each styled toast now carries a 3px leading-edge rail and matching icon color drawn from the semantic tokens (success/info/warning/destructive; loading borrows info, default stays a quiet gray), so a collapsed stack still reads its severities. Action buttons become ghost outlines instead of inverted solid blocks, toast padding tightens slightly, and the description color moves off Sonner's hardcoded grays onto `--muted-foreground` for both light and dark. Placement (bottom-right), stacking, and all existing geometry fixes are unchanged — this is a pure visual layer over the current `toast()` API. Direction picked from the `/prototype/toasts` lab (variant B, Linear/Primer-flash style); the prototype route has been removed.

---
"cognia-next": patch
---

Fix the inverted animation-speed preference. Settings → Appearance → A11y labels its options "Fast (1.5×)" and "Slow (0.5×)", but the value was written straight into `--motion-duration-scale`, which animations multiply by their base duration — so picking "Fast" made every dialog, sheet, panel and dock transition 50% _slower_, and "Slow" made them faster. Speed and duration are now correctly treated as reciprocals at the single point that converts them.

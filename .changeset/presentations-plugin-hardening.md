---
"cognia-next": minor
---

Presentations plugin overhaul: declarative manifest i18n (en + zh-CN) replaces activation-frozen labels, the slide renderer now uses host design tokens with container-query font scaling, rounded shapes, real charts/tables, speaker notes, an empty state, and a live validation panel. PPTX import keeps slide order, geometry, text runs, images, tables, native chart data, and speaker notes instead of flattening everything to text; export allocates collision-free shape ids and normalizes colors. Tool schemas are closed per element type with structural validation in the model layer, results render in a shared `ToolCard` with an open-artifact action, and file/ownership handling is tightened (single-file picker, owner checks, source-filename export names).

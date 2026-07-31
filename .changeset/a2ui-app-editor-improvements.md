---
"cognia-next": minor
---

A2UI App editor overhaul: the "AI Generate" button now drives a real model turn (reusing the Claude send pipeline with PII gating, streaming into the canvas, and an automatic template fallback) and gains natural-language editing of the current app; the Publish tab now mints a real, revocable hosted share link and records published state. Adds favorites (star + filter), blank-app creation, import-from-share-code, save-as-template, data-model path autocomplete for property bindings, drag-and-drop reordering in the component tree (top/bottom-half drop position), and A2UI-scoped motion/layout polish (animated tree chevron, comparison-card hover, reduced-motion support, bounded preview cards).

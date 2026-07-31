---
"cognia-next": patch
---

Web search settings: fix broken translations and rebuild the layout. The Behavior, Safety, Performance (cache), Diagnostics (usage), and provider-compare sections read from the wrong i18n namespaces and rendered raw keys — they now resolve correctly in English and Chinese, and the section navigation gains its missing labels/descriptions. The page is reworked into a full-height, bordered master/detail two-pane layout (matching the AI Providers page) with a richer section rail that fills the available space.

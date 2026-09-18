---
"cognia-next": patch
---

Put the /plugins library filter strip literally first in the list column — above the category-sheet fallback row on narrow panes, so the strip is unambiguously the column's top element as intended. Internal tidy-up: the section badge now reads its icon through `pluginNavItem()` instead of an open-coded map lookup.

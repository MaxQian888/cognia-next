---
"cognia-next": patch
---

Redesign the route-level error page (error / not-found / global-error). The nested card stack — an outer card wrapping a destructive alert card beside two bordered panels — is replaced by one bounded panel whose detail sections are flush rows split by hairlines, with the icon, title and category chip on a single header line instead of a centred hero. Expanding the stack trace now behaves: the trace scrolls horizontally only (no more nested vertical scrollbar or `break-all` shredding frame paths), grows inside the page's single scroll band, and scrolls itself into view when opened. The trace disclosure is also localized (previously hard-coded English) and the system-diagnostics rows are laid out as a compact matrix.

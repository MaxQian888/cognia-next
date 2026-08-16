---
"cognia-next": minor
---

Reordering conversations in the sidebar now reads as a move: the dragged row follows the pointer as a lifted clone while its slot stays in the list, the dropped order is shown immediately (no more glide-back-then-snap), the clone settles into the new slot, and the moved row briefly carries the same landing mark conversation jumps use — so swapping two similar-looking rows is no longer ambiguous. Under reduced motion the clone simply lands and the mark alone says where the row went.

The conversation list also emits behavior-telemetry events (subject to the existing telemetry consent, category switches and sampling): open (click / keyboard / branch link), new chat, settled search (query length only), reorder, row and bulk actions, view switch, section fold, display-option and quick-filter changes. Attributes are ids and enums only — never a title, query text or a folder / preset name.

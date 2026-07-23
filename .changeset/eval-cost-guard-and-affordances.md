---
"cognia-next": patch
---

Three eval-UI affordance fixes.

The cost guard's button labels were inverted: it read "Run anyway" _before_ the confirmation — where clicking only acknowledged and launched nothing — and reverted to a plain "Run" for the click that actually spent the money. The confirming click is now the one labelled "anyway", and the first click gets an explicit message instead of only a label swap.

The run comparison grid announced "no per-case results recorded" while it was still loading them, which reads as a finished, empty answer. It now shows a loading state and reserves the empty message for a comparison that genuinely has no shared cases.

The dataset detail header put five actions side by side next to three badges, wrapping onto three rows inside the 320px detail pane. Run stays a primary button; import, the two exports and the quality gate move into an overflow menu.

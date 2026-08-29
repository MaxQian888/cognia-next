---
"cognia-next": patch
---

Agent Team: the HITL approval gate now says what it is releasing. The dialog is mounted at the app root, so it can appear over any surface, but it only ever rendered a generic per-kind heading ("Token budget critical") — the gate's own title was dropped and the scope id it approves against was declared "display only" and then never displayed, so two simultaneous budget gates from two different runs looked identical. The header now carries all three signals: the producer's title, the gate kind, and the scope id. The mobile team workspace also stopped mounting a second copy of the gate host on top of the app-root one, which stacked two dialogs per gate with two competing focus traps.

---
"cognia-next": patch
---

Eval gates now distinguish "we couldn't tell" from "it failed". A run where no case could be graded reported a pass rate of zero, which every threshold read as a total failure — so a dataset whose references never said how to compare them looked exactly like an agent that got everything wrong. Gate results now carry a verdict of pass, fail, or inconclusive, with the reasons listed separately from real threshold breaches, and a gate can now name the scorers that must actually have run for its verdict to mean anything. A genuine breach still outranks missing evidence. The Eval gate workflow node keeps its two branches and routes an inconclusive run down "fail" so a workflow never proceeds on evidence it does not have, while its output and log now name the real verdict.

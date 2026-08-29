---
"cognia-next": minor
---

A staged `@` reference now says when the record behind it has changed.

Referencing a plan, a memory or a conversation captures a snapshot: what you read in the picker is what the model gets. That is the right default, but the record can move underneath it — advance three steps of the plan between staging it and hitting send and the old plan was quietly the one that went.

The chip now watches. Each staged reference records the source's version when it was captured, re-checks it when the window regains focus and once more at send, and grows a badge plus a one-click re-read when the two diverge. The snapshot itself is never rewritten behind you: approving one body and sending another would be the worse failure. Instead the prompt block says when the copy was taken, so the model treats it as a snapshot rather than as the current state.

A reference whose kind cannot report a version is left alone rather than reported as stale.

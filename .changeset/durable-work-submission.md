---
"cognia-next": minor
---

Persist chat turns before dispatching them. A message you send is now committed together with its frozen input and execution run in a single transaction, so a crash can no longer leave a visible message that nothing will ever answer. Stranded work is recovered on restart, and never replayed automatically once a tool has run.

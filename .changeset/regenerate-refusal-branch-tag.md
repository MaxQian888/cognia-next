---
"cognia-next": patch
---

A regenerate that is refused (a plugin prompt guard, the concurrent-stream cap, an unroutable conversation, or any later refusal before the turn runs) no longer files the next turn's reply under the old answer as a hidden sibling. The previous reply is only moved into a branch group once the turn is accepted, and a refused edit no longer leaves the branch navigator pointing at a question that was never added.

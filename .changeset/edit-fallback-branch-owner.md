---
"cognia-next": patch
---

Editing a question that a delegation rule sent to an external agent now keeps the built-in fallback's reply under the edited question when the external run fails: flipping the branch navigator back to the original no longer shows the fallback answer, and the navigator stays on the edit instead of pointing at a message that was never added.

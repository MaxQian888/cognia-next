---
"cognia-next": patch
---

Regenerating a turn answered by an external agent (such as an `@codex` turn) or by a Squad now files the new answer as another version of the old one, the same way a built-in reply does. Previously both answers showed at once and the version switcher never appeared. Editing a question on those lanes also keeps the new answer with the edited question, so switching back to the original hides it.

---
"cognia-next": minor
---

External agents such as Codex can now ask optional, non-blocking questions inline in the transcript — the turn keeps running and each question can be answered later, with suggested options or free text. Async message questions answer with an ordinary reply; Codex `requestUserInput` requests flagged `isBlocking: false` answer by resolving the pending request directly, and secret questions are masked and never persisted. The feature is opt-in via Settings → Conversation → inline questions; when disabled the same questions still arrive as plain text so nothing is lost.

---
"cognia-next": minor
---

Fleet island now handles Claude Code's `AskUserQuestion` as an answerable question instead of a generic command approval. Because the tool fires both `PreToolUse` and `PermissionRequest`, its permission long-poll was being parked as a plain Approve/Deny card, hiding the actual question. The island now renders the question(s) with selectable options (single- and multi-select) and a Submit control; the selection rides back to the agent as the hook's `allow` + `updatedInput.answers` decision, so the agent resolves without touching the terminal. If the answer window lapses the card fails open to the terminal picker. The island force-expands (and re-measures its height) while a question is answerable.

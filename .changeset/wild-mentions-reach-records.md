---
"cognia-next": minor
---

Extend the composer's `@` menu to reference first-party records, and fix four gaps in the existing mention plumbing.

- New namespaces: `@memory:`, `@issue:`, `@plan:`, `@chat:` and `@artifact:` search the corresponding records and stage the picked one as a context chip. All five are Dexie-backed, so they work on every shell — including the phone and the browser, where `@` previously reached almost nothing.
- `@file:` and `@agent:` join the vocabulary, matching what the CLI has always accepted; `@file:` narrows the panel to files only.
- `@` now completes inside a slash command's arguments (`/review @src/a`). It could always be typed and was always resolved at send time, but the picker never opened there.
- Chip-style picks — a staged Feishu/Google document, a staged record — are now recorded in a message's mentions. They leave no token behind, so re-parsing the text could never find them, and their citations are now folded into the chat-history search index, making an attached issue or document findable by name.
- A plain browser with no paired device now explains that file references need one, instead of showing an internal error string inside the file picker.

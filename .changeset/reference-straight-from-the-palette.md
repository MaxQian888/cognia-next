---
"cognia-next": minor
---

Reference a ⌘K result straight into the conversation you are in.

Global search could already find a message inside another conversation — it has run on the chat-history index since it shipped — but the only thing a hit could do was take you there. You searched for the thing you wanted to reuse, found it, and then had to go and find it a second time from the composer's `@` menu.

Referenceable rows now carry a second action: an `@` control on the row, or ⌘↵ on the highlighted one, stages the record as context for the conversation you are in and closes the palette. It works for a conversation, a single message, a memory and an issue — the kinds whose records have a body a model can read.

A reference made this way and one made from the composer are the same reference: same chip, same prompt block, same citation, same untrusted-content handling, because it is the same code path.

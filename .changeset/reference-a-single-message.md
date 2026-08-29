---
"cognia-next": minor
---

Reference one message from another conversation with `@msg:`, and widen it to the turns around it.

`@chat:` could only reach a whole conversation — its last forty turns, with every tool output stripped — and could only find that conversation by matching its title. So the common case, "use the thing that came out of the other chat", had no way to be expressed.

`@msg:` searches message **content** across every conversation, through the same index ⌘K already searches, and stages the one message you pick. Its body carries the tool output the transcript snapshot drops, which is usually the part worth referencing. The staged chip has a control to widen the reference to the turns on either side, up to ten each way, and the prompt block names the message's permalink so the assistant can hand the link back.

Like `@chat:` and `@issue:`, a referenced message is wrapped as untrusted content — more sharply than either, because the tool output it now carries is the text most likely to have been written by somewhere else.

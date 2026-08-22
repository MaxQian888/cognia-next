---
"cognia-next": patch
---

Discord answers arrive as one message again.

Every text, markdown, code, mention and emoji segment became its own Discord message, so a reply of "Here is the fix:" followed by a code block posted twice — and because each fragment carried the reply reference, replying to someone pinged them once per fragment instead of once. Consecutive segments now share a single message: paragraphs are separated by a line break, a fenced code block still gets its own lines so Discord renders it, and an inline mention stays inside the sentence around it. A2UI surfaces and media still get their own message, in the same position as before.

Editing a message no longer loses most of it either. The edit used to take the first text segment and drop everything after it, so editing a message that mixed prose with a code block truncated it to the opening sentence.

---
"cognia-next": minor
---

A preview toggle and a mobile safety net for `{{parameter}}` messages.

The composer gets an eye control, shown only when the message actually has parameters, that swaps the input for a read-only rendering with every value filled in — the answer to the one real cost of keeping the token in the text, which is that while editing you see `{{module}}` rather than the finished sentence. Toggling back returns you to exactly where you were.

On mobile, a draft that synced across from the desktop arrives with its tokens but not their values, because the sync protocol carries the draft text and its attachments and nothing else. Sending one is now refused, with a message saying to finish it on the desktop, rather than shipping a literal `{{module}}` to the model. The check reads the tokens straight out of the text, so it holds on a device that never received the values at all.

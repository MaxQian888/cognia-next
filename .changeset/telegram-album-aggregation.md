---
"cognia-next": patch
---

A Telegram photo album is now one message, not five.

Telegram has no multi-photo message on the wire: an album arrives as N separate updates sharing a `media_group_id`, with the caption attached to exactly one of them. The bot treated each as its own message, so posting five photos got five answers — and because four parts carried no caption, trigger rules that key on the caption matched at most one of them, which is why an album sometimes produced one relevant reply and four confused ones.

The parts of an album are now assembled into a single event before anything else looks at them, so the caption reaches trigger matching, all the photos reach the model together, and the bot answers once. A full ten-part album emits as soon as its last part lands rather than waiting out a timer, and a partial one closes after a short quiet period. Stopping the bot flushes whatever has arrived instead of dropping it.

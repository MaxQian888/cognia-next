---
"cognia-next": patch
---

The Discord connector escapes every message and channel id it puts in a request URL (send, edit, delete, reactions, pins, typing, history, interaction callbacks), and Lark escapes reply ids, so a crafted id can no longer redirect a request to another channel.

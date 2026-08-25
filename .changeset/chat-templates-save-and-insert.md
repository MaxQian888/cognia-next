---
"cognia-next": minor
---

Save a message as a template and reuse it from the `/` menu.

A bookmark control appears beside the composer whenever there is something to save. Name it, and every `{{parameter}}` already in the message becomes a declared parameter — no form to fill in first, because the tokens are already in the text.

Saved templates appear as their own section at the bottom of the `/` menu, never mixed in with commands: picking a template inserts a message body, where picking a command drops `/name` in for you to review, and two different outcomes from one list is exactly what gets clicked by mistake. Inserting one lands the caret on the first parameter that still needs a value with its editor already open, and pre-fills the rest with whatever you set them to last time — in practice most values repeat.

Templates are stored on this device only for now; they do not follow your account to another machine.

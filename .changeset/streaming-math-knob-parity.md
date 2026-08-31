---
"cognia-next": patch
---

Chat: the math font-scale and math alignment appearance settings now apply while a reply is streaming and inside reasoning blocks, not only after a turn finishes. Both knobs previously reached the finalized renderer alone, so math rendered at the default size and centring for the whole turn and then jumped to the configured size/alignment the moment the turn sealed.

---
"cognia-next": patch
---

Deleting a submitted crash report now falls back to its one-time deletion credential when this installation's grant can no longer reach it (after a reinstall or a lost installation key), and `cognia crash delete --remote --deletion-credential` deletes one without a grant; `crash submit` prints the credential once.

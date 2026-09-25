---
"cognia-next": patch
---

Public share links now open for someone with no Cognia account. On the public share site, a fresh browser used to get the "Create local account" form instead of the share. Creating an account then sent it to setup, which dropped the link and its decryption key. `/share/view` now renders the share straight away in a minimal guest view: no account, no app database in the visitor's browser, and no "Add to my library" button, because there is no library to add to. If this browser already has a locked account, the unlock screen stays first, so the owner can unlock in place and keep the import actions, with the link untouched. "Read without unlocking" is there for anyone else. A first-run account that opens a link is no longer redirected into setup, and team sign-in no longer stands in front of a share.

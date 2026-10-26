---
"cognia-next": patch
---

A multi-tenant Host no longer restarts its brain in a loop when `COGNIA_COLLAB_URL` is set without `COGNIA_COLLAB_ORG_ID`, and sending, editing or reading messages in a conversation the Host does not hold now answers `SESSION_NOT_FOUND` instead of an internal error.

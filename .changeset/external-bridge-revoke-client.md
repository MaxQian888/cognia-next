---
"cognia-next": minor
---

External Bridge: a client credential can now be revoked, not just rotated. Settings → External Bridge → Server & token gains a Revoke control (host-managed bridges) that ends the grant immediately and closes the client's live sessions, and clears the one-time credential from the screen so a dead value can't be pasted. Rotation was previously the only option, which issues a replacement rather than shutting off access — there was no kill switch for a leaked credential even though the backend, the API wrapper and the `revokedAt` state all supported one.

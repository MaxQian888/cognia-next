---
"cognia-next": patch
---

Cloud sign-in lifecycle is now honest about its state. An expired or revoked Logto session is no longer reported as active: the Account settings card shows a "sign-in required" state naming the reason, an unreachable identity provider shows as offline with local data untouched, and a rejected refresh clears the dead tokens. Signing out now revokes the tokens at the identity provider (and says so when it could not). Deleting a local account now also removes its cloud identity: the Logto session, the profile-to-person binding, the collaboration-server address and the host's record of the person, with any step that failed reported instead of silently skipped. The pre-ADR-0149 global Logto session left in the keyring is discarded at boot.

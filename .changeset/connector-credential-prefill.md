---
"cognia-next": minor
---

Connector credentials are now read back into their settings fields instead of being write-only. Reopening a bot's configuration shows the stored value in a password-styled box with a reveal toggle, identifiers (app key, app id, bot id) stay readable, and every field says which state it is in — saved and shown, never set, or saved on the host but not readable from this shell. Emptying a field you can actually see now clears the credential; a blank box you were never shown still means "leave it alone", so a remote or refused read can never delete a working bot's keys. Wired into the DingTalk dialog first.

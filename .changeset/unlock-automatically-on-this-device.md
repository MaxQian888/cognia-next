---
"cognia-next": minor
---

Local accounts stop asking for the password over and over. Any desktop profile can now "Unlock automatically on this device", ticked on the lock screen or turned on in Settings → Account → Security. The password is kept in the native secret store and still works whenever automatic unlock can't run, and the lock screen says why. Profiles that open without a prompt no longer show a Lock button and are never idle-locked. Idle auto-lock now defaults to Never. A browser tab remembers its unlock until it closes, so a reload no longer asks again. Switching accounts without a password no longer locks you out of the current one.

Fixes:

- The recorder strip no longer shows its own lock screen.
- Acknowledging a second profile's recovery key no longer deletes the Local workspace's key.
- A locked credential store now offers an "allow access" action instead of a dead end.
- A development hot reload no longer strands the app on "Loading accounts".

Development builds keep their secrets in a file-based dev store instead of the macOS Keychain (`COGNIA_DEV_KEYCHAIN=1` opts back in), skip onboarding for the auto-created desktop workspace, and no longer reload the page when the dev server's first compile is slow (`COGNIA_WEBVIEW_WATCHDOG=1` re-enables that).

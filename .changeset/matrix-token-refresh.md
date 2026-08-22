---
"cognia-next": patch
---

**A Matrix bot no longer dies for good when its access token expires.**

Matrix homeservers can issue access tokens that expire. The refresh token that comes with them was being thrown away at login, so when the token lapsed the bot simply stopped and the only way back was to open settings and sign in again — which creates a new device, and a new device cannot read anything that was encrypted for the old one.

The refresh token is now kept, and an expired access token is renewed automatically, in place, keeping the same device and its encryption keys. A renewal happens once per failed request: if the homeserver still refuses afterwards, the bot reports that it needs signing in again rather than hammering the server.

The difference between "your session ended" and "the network hiccuped" is now respected too. A dropped connection or a locked keyring is retried; only a refresh token the homeserver has actually rejected asks you to sign in.

---
"cognia-next": patch
---

Google document provider: "Disconnect" now revokes the authorization at Google instead of only forgetting the tokens locally. Previously the refresh token stayed valid on Google's side, so a disconnected connection was still a live grant the user had to hunt down in their Google account settings. Revocation is best-effort — local state is always cleared, and when Google rejects the call the toast says so and points at the account page to finish.

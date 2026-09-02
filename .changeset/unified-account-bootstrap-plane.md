---
"cognia-next": minor
---

The collaboration server gains an account control plane, behind `COLLAB_ACCOUNT_BOOTSTRAP_ENABLED`: `GET /v1/account/memberships` lists every organization a signed-in person belongs to, `POST /v1/account/bootstrap` lets the first owner claim a deployment with a one-time credential (creating the Logto organization and the Cognia org in a resumable saga), and `POST /v1/invitations/accept` redeems an opaque invitation with a plain sign-in session. The server-assigned user id is now canonical: a profile that was bound with a locally derived id is reconciled to the server's id on its first refresh, with the old id kept as an alias. Auth-config discovery (`GET /api/auth/config`) is versioned and advertises the native client id, the enabled social sign-in providers, the callback modes, and the collaboration service. The Logto client can start a social sign-in directly.

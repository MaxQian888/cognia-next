---
"cognia-next": minor
---

Lark/Feishu on self-hosted deployments: the reference Compose stack now passes `COGNIA_LARK_PUBLIC_BASE` / `COGNIA_LARK_WEB_BASE` through to `cognia-server`, and the server validates both on boot — a base with no scheme, plaintext `http://` on a public host, a query string or embedded credentials now refuses to start and names the variable, instead of surfacing later as an opaque 503 to a user inside a Feishu client. Loopback origins and a web base with no companion behind it warn and start. A malformed value is also no longer stamped into the OAuth `redirect_uri`.

Adds a **Web sessions** card to the Lark adapter settings: the companion keeps web sessions stateless, so the brain now records each sighting (hashed session id, never the raw token) and the card shows who holds a live, expired, or revoked session, with a retention-window prune. Disabling or unlinking a principal — which is what actually cuts access off — now stamps that person's sessions revoked.

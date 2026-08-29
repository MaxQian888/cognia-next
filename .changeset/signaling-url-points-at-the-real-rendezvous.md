---
"cognia-next": patch
---

Fix the Host advertising a signaling endpoint it does not serve. `/api/auth/config` synthesised `{scheme}://{host}/signaling` from the incoming request, which claims the companion listener serves `/signaling` — it does not (it mounts `/ws/events`, `/ws/acp`, `/ws/terminal` and `/ws/worker`; signaling is a separate service). A browser on the loopback plane was handed `ws://127.0.0.1:27891/signaling` and got a failed WebSocket handshake every time, while the Host sat in `wss://signaling.cognia.cn/signaling` waiting for it.

Signaling is a rendezvous, not an ingress: two peers that dial different servers join different rooms and never meet, so the endpoint the Host itself joined is the only value that is right by construction — and `SignalingHub` knows it. The same-origin guess is still correct for one deployment, a reverse proxy fronting both the companion API and the signaling service on one origin, and that case announces itself through `x-forwarded-host` / `x-forwarded-proto`, so it keeps the old answer. `COGNIA_PUBLIC_SIGNALING_URL` still outranks everything for operators translating an internal address into a public one.

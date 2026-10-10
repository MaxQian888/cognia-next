---
"cognia-next": minor
---

Pair an always-on host from anywhere: `cognia-server pair` waits for the relay, prints a QR code and the expiry, takes `--port`, and refuses a relay-less invitation with the reason unless `--direct`; the desktop can pair a host as an always-on host without switching to it; and `cognia-agent host login --invitation 'cgnp4|…'` pairs directly or through the relay, now also with self-signed hosts.

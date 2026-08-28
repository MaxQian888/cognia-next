---
"cognia-next": minor
---

Headless hosts can now enrol the browser companion extension. `cognia-server devices enroll-browser` mints the one-time browser enrollment that used to exist only behind the desktop settings card, and `pnpm dev:headless browser-enroll` encodes it into the `cgnb1|…` code the extension accepts — a different code from the `cgnp3|…` pairing invitation `pair` prints, which the extension has always refused. Before minting anything, the command verifies over `/healthz` that the plaintext loopback listener the code will advertise is bound and belongs to this deployment, so a code that could not possibly connect is refused in the terminal instead of failing later inside the side panel.

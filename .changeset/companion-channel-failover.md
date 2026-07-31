---
"cognia-next": minor
---

Mobile ↔ desktop pairing now knows about every channel its desktop is reachable on, instead of only the single address the QR code happened to carry.

The pair payload can encode exactly one base URL — the desktop picks its tunnel over its LAN address when both exist — which left each pairing with a one-way view of a two-way host:

- **Paired on the LAN, then left the network**: the phone never learned the cloudflared tunnel URL, so the only remaining route was the WebRTC tier. With WebRTC disabled, the signaling service unreachable, or a symmetric NAT and no TURN relay, there was no route home at all short of re-pairing.
- **Paired over the tunnel, then came home**: the payload's TLS fingerprint is empty (Cloudflare terminates TLS upstream), and the LAN re-resolver refuses to trust an unpinned LAN hit — so such a device could never be promoted back to the LAN. It kept routing through Cloudflare while sitting next to the desktop.

The desktop now answers a read-only `companion_endpoints` request with its full reachability set (LAN address, tunnel URL, self-signed TLS fingerprint, installation id). Paired clients refresh it on every successful connect and cache it, which closes both directions: a LAN-paired phone gains a WAN fallback, and a tunnel-paired phone finally gets the pin it needs to move back onto the LAN.

When a network change leaves the transport disconnected and no LAN address answers, the client now sweeps the remaining channels in priority order — LAN, then tunnel, then the pair-time address — and repoints at the first one that responds. Each candidate is verified against the pinned fingerprint before it is adopted, so a squatted tunnel hostname cannot attract the connection. A connection that is still live on another channel is never torn down to go probing.

Nothing exposed here is a secret: the fingerprint appears in every TLS handshake, and the tunnel hostname only forwards to the same authenticated surface. Every paired device may ask how to reach its own host, so the request needs no remote-control grant; on a headless `cognia-server`, which has no tunnel launcher, the tunnel field is simply absent.

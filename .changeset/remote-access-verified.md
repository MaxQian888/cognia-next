---
"cognia-next": minor
---

Remote access is verified instead of assumed (ADR-0172). Settings → Connectivity → Cloud & relay now opens with one verdict on whether a device away from this network can reach the Host, and a "Test relay" button that asks the rendezvous what it can carry: the signaling server's `/healthz` advertises its protocol and lanes, so a deployment that predates the relay data lane reads as "legacy" rather than as working. The desktop detects whether `cloudflared` is installed before the tunnel switch is touched and shows install steps per OS (shared with the Connections tunnel tab, now translated), detects Tailscale and ZeroTier and can advertise the overlay address in pairing invitations so a phone on the same private network pairs from anywhere over the plain HTTPS route, and the single cloudflared process refuses to be silently repointed between the companion listener and the webhook receiver: both surfaces show the conflict and offer an explicit replace.

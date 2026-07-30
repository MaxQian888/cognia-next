---
"cognia-next": minor
---

Give the browser the same connection resilience the phone has when it talks to a Cognia server.

Opening Cognia in a browser against a self-hosted or cloud `cognia-server` produced a client that could connect but could not recover well. Everything that keeps a connection alive across a changing network — learning the other addresses the host answers on, re-probing when connectivity returns or the tab comes back to the foreground, failing over to a different channel when the current one dies, provisioning TURN credentials, and the direct peer-to-peer tier — was written once and then gated behind a phone check, so a browser got none of it. All it had was the WebSocket's own reconnect backoff.

None of that work is actually phone-specific. The one piece that genuinely is — discovering a host on the local network, which needs mDNS and a subnet sweep — is now the only thing still gated; the browser skips discovery and uses the addresses the host reports over the authenticated connection instead, which was the only route available to it anyway. Everything else runs in both.

The practical difference: a browser session survives a network change, follows the host if it moves between a tunnel and a direct address, and can negotiate a direct connection rather than relaying every message through the server.

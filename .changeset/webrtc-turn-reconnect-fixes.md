---
"cognia-next": patch
---

Fix WebRTC remote access on desktop and make reconnect feedback accurate.

TURN provider tests and credential rotation now use a native Tauri command, avoiding WebView CSP failures while keeping saved provider secrets in the OS keyring. WebRTC negotiation waits for the opposite peer before sending an offer, bounds that wait separately from ICE negotiation, and reconnects when a peer leaves or a previously failed tier is retried. Reconnect actions now distinguish an in-progress attempt from throttling instead of reporting success for a no-op.

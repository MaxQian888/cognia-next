---
"cognia-next": patch
---

A phone paired to a desktop can now manage IM connector credentials and drive the Pro IDE workbench. Eight commands the command manifest advertised as remotely callable were answering `503 headless_host_required` on a desktop host: the four `connectors_keyring_*` arms demanded a headless registry they never used, and the four `codeserver_*` lifecycle arms ignored the desktop's own code-server, which `dispatch_host.rs` already reaches for every read verb. Binary WebSocket frames also work on a headless host now, where `connectors_ws_send` silently required text, and a caller-preallocated WebSocket handle survives a reconnect there instead of coming back under a fresh id.

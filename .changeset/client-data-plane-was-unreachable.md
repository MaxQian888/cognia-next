---
"cognia-next": patch
---

Fix the entire client data plane answering 403 to every paired device. Twenty-two commands — `sync_pull`, `session_list`, `message_send`, `app_settings_update`, `twin_profile_get` and the rest of the mobile/web mirror — were classified `target: "client"` with internal-only transports in the command manifest, which makes `authorize_transport` refuse every device transport before the capability check even runs. They are all in `KNOWN_COMMANDS` (the device-reachable dispatch list), none of the 630 genuinely renderer-local commands are, and the protocol's own disposition catalog described them as "reachable remotely through the desktop-write bridge arm" — so the classification contradicted every other source of truth. They are now `target: "execution"` over http/websocket/webrtc, and the public OpenAPI surface gains the 22 paths it was always meant to expose.

Two request contracts that would have turned that 403 into a 422 are fixed with it: `sync_pull` now accepts the `content_protocol_version` its only caller has always sent, and the three `host_state_*` commands no longer require a `protocolVersion` field that the brain's own closed-request check rejects — HostState was unreachable from any device in both directions at once.

---
"cognia-next": patch
---

Fix the defects a two-axis review of the selection-toolbar, conversation-anchor and Gateway/Bridge work turned up.

The system-wide selection toolbar could not appear at all. `selection_toolbar_resize`, `_set_keep_alive` and `_finish` were granted only by the generated all-commands permission, which is attached to a capability scoped to the main window — so every call from the overlay window was rejected, the first measurement never landed, and the reveal it gates never ran. The overlay's own permission file now lists them, a test asserts it lists every command the overlay invokes, and a failed resize reveals the window anyway rather than leaving it invisible.

`⌥⇧1`–`⌥⇧6` cancelled themselves: the input tap is listen-only and reports no modifiers, so the chord's own digit read as "the user moved on" and cleared the candidate before the shortcut handler could use it. A key press now waits for a chord to claim it, and a bare modifier never dismisses. Escape had the same shape of bug on macOS — it was compared against a raw key code the tap never emits, so it never matched.

The Gateway's config writer read the current config out of a `setState` updater, which React defers whenever another update is pending — and the status and cooldown polls keep one pending. A single toggle therefore shipped `port`, `allowlist`, `exposedModels` and `disableKeywords` back to their defaults.

Route tickets had no issuer: a gateway-routed execution spec silently degraded to a direct route, so the panel that lists and revokes them could never show anything. Turns now mint a ticket and stamp its endpoint and one-shot secret into the agent subprocess env.

The External Bridge's stdio sidecar was never built or shipped for the desktop app — both the spawn path and the "paste this into Claude Desktop" snippet pointed at a `~/.cognia/cognia-mcp.js` that nothing installs. It is now bundled with the app, resolved by one Rust resolver both paths share, and the setup panel says so when it is missing instead of printing a path that is not there. Editing the bridge's HTTP port also restarts the listener rather than leaving it on the old port in silence.

Jumps that cannot resolve now say so everywhere rather than only from the artifact dock — including the timeline's starred-reply rows and message permalinks, which previously consumed the link before jumping, so a failed jump left nothing to retry. "Locate in conversation" works more than once per terminal tab. Date headers in the expanded timeline stick again past 40 turns. Memories captured from the selection toolbar keep their `selection` provenance through a backup round-trip.

Also: the request log's cost, both latency columns and the toolbar's playback percentage are locale-formatted instead of hard-coded en-US; the Gateway nav's `!` badge has an accessible name; and the streaming stall message quotes the configured idle timeout rather than always 300s.

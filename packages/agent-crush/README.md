# @cognia/agent-crush

Crush v0.98.2 integration for Cognia's ADR-0217 host ports. A dedicated package is needed because Crush's native workspace/session HTTP and snapshot events differ from ACP and OpenCode; its manifest can be loaded without a runtime or Node dependency.

`CrushAdapter` takes `fetch`, `outboundGate`, `redactDiagnostic`, `approvalPolicy`, optional `isToolPreApproved`, and a session service `launch` port. It creates native workspaces/sessions, subscribes before submitting a uniquely identified run, ignores preexisting message snapshots, maps native permissions, and finishes only on the matching `run_complete`. Resume reopens the native session, and cancellation reaches only the running native turn.

The app uses `createCrushSocketBridge({processHost,outboundGate,resolveBridgeLaunch})`, whose returned `fetch` and `launch` carry HTTP through a private Unix socket in an owned 0700 temporary directory. The Node-only executable subpath is `@cognia/agent-crush/node-bridge`, with fixed argv `--cognia-crush-bridge`. The host must resolve verified Node/native Crush executables, enforce the process sandbox, and reap process groups. There is no public TCP fallback. Local native execution is supported on macOS/Linux; selected containers and Windows are rejected by the app integration.

Host MCP injection, arbitrary extra workspace roots, interactive questions, model/reasoning controls, forks and forcing approvals for native tools that never request permission are rejected. Configured `requireApprovalFor` is therefore refused. Native account/configuration remains upstream-owned; this package does not install or authenticate Crush.

Contract sources: [server endpoints](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/server/endpoints.go), [event envelopes](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/server/events.go), [message schema](https://github.com/charmbracelet/crush/blob/v0.98.2/internal/proto/message.go).

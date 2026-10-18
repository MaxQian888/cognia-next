# @cognia/agent-acp

Agent Client Protocol integration (ADR-0217): the `acp` client (`./client`:
stdio, HTTP, SSE and WebSocket transports; session setup, prompt turns,
permissions, elicitation, `fs/*` and `terminal/*` requests, terminal
authentication, resume, fork, compaction and dynamic MCP), the wire codec
(`./wire-codec`), the negotiated feature profile (`./feature-profile`),
permission-input recovery (`./permission-input`), the ACP Registry v1 client
(`./registry`), the per-conversation Devin adapter and model axis
(`./devin-adapter`, `./devin-model-axis`), the shared isolated lifecycle
(`./isolated-adapter`) and MiniMax Code adapter (`./minimax-adapter`), the vendor profiles
(`./vendor-profile`, `./vendor-profiles`, `./vendors/<id>`) and the protocol
semantics (`./manifest`).

The client reaches the machine only through `AcpClientDeps`: the host's
process, file and terminal ports, its request and streaming fetches, its
WebSocket factory, its ACP capability truth, launch environment, approval
policy, allow-list check, outbound gate, dynamic-MCP gateway and logger.
Every outbound frame passes the gate. ACP is a protocol, not a vendor, so the
manifest contributes protocol semantics (stdio, network, per-conversation) and no
ecosystem row. `./manifest` loads no runtime code.

Vendor deviations are data, not branches: an `AcpVendorProfile` states a
vendor's permission-mode vocabulary, launch settings, unsupported session MCP
or prompt capabilities, unfinished compaction, fork constraints and the tool
identity it carries in metadata, and the client applies them at fixed points.
MiniMax Code, Kimi, Cline, Qoder, Goose, Devin and OpenCode-over-ACP ship as profiles,
selected by preset id or executable name; a host may pass its own set as
`vendorProfiles`. Profiles describe protocol behaviour and grant nothing.

The app wires the client in `lib/ai/agent/external/integrations/acp.ts`.
Checked by `node scripts/build/pack-test-agent-package.mjs agent-acp`.

MiniMax Code 0.6.12 uses two axes: process-wide `permissionMode` via
`session/set_config_option`, and interaction `default`/`plan` via
`session/set_mode`. Each conversation owns a process, including restore/fork.
Native `default` can preapprove reads, edits and classified shell operations
without an ACP permission request; Cognia handles the requests it receives.
Native full access maps to `bypassPermissions`. `acceptEdits`, `dontAsk` and
`requireApprovalFor` are refused because ACP cannot enforce those stricter
policies. Native Auto is hidden. No App Server or vendor extensions are used.

Run `COGNIA_MINIMAX_MCODE=/absolute/path/to/mcode pnpm exec tsx
scripts/smoke/minimax-acp-smoke.ts` for the real CLI/sandbox test against a
synthetic local provider. It uses temporary state and requires no cloud login.

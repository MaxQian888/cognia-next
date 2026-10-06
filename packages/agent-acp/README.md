# @cognia/agent-acp

Agent Client Protocol integration (ADR-0217): the `acp` client (`./client`:
stdio, HTTP, SSE and WebSocket transports; session setup, prompt turns,
permissions, elicitation, `fs/*` and `terminal/*` requests, terminal
authentication, resume, fork, compaction and dynamic MCP), the wire codec
(`./wire-codec`), the negotiated feature profile (`./feature-profile`),
permission-input recovery (`./permission-input`), the ACP Registry v1 client
(`./registry`), the per-conversation Devin adapter and model axis
(`./devin-adapter`, `./devin-model-axis`), the vendor profiles
(`./vendor-profile`, `./vendor-profiles`, `./vendors/<id>`) and the protocol
semantics (`./manifest`).

The client reaches the machine only through `AcpClientDeps`: the host's
process, file and terminal ports, its request and streaming fetches, its
WebSocket factory, its ACP capability truth, launch environment, approval
policy, allow-list check, outbound gate, dynamic-MCP gateway and logger.
Every outbound frame passes the gate. ACP is a protocol, not a vendor, so the
manifest contributes protocol semantics (stdio, network, Devin) and no
ecosystem row. `./manifest` loads no runtime code.

Vendor deviations are data, not branches: an `AcpVendorProfile` states a
vendor's permission-mode vocabulary, launch settings, unsupported session MCP
or prompt capabilities, unfinished compaction, fork constraints and the tool
identity it carries in metadata, and the client applies them at fixed points.
Kimi, Cline, Qoder, Goose, Devin and OpenCode-over-ACP ship as profiles,
selected by preset id or executable name; a host may pass its own set as
`vendorProfiles`. Profiles describe protocol behaviour and grant nothing.

The app wires the client in `lib/ai/agent/external/integrations/acp.ts`.
Checked by `node scripts/build/pack-test-agent-package.mjs agent-acp`.

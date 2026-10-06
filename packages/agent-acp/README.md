# @cognia/agent-acp

Agent Client Protocol integration (ADR-0217): the `acp` client (`./client`:
stdio, HTTP, SSE and WebSocket transports; session setup, prompt turns,
permissions, elicitation, `fs/*` and `terminal/*` requests, terminal
authentication, resume, fork, compaction and dynamic MCP), the wire codec
(`./wire-codec`), the negotiated feature profile (`./feature-profile`),
permission-input recovery (`./permission-input`), the ACP Registry v1 client
(`./registry`), the per-conversation Devin adapter and model axis
(`./devin-adapter`, `./devin-model-axis`) and the protocol semantics
(`./manifest`).

The client reaches the machine only through `AcpClientDeps`: the host's
process, file and terminal ports, its request and streaming fetches, its
WebSocket factory, its ACP capability truth, launch environment, approval
policy, allow-list check, outbound gate, dynamic-MCP gateway and logger.
Every outbound frame passes the gate. ACP is a protocol, not a vendor, so the
manifest contributes protocol semantics (stdio, network, Devin) and no
ecosystem row. `./manifest` loads no runtime code.

The vendor branches for Devin, Kimi, Goose, Qoder, Cline and OpenCode-over-ACP
still live inside the client; extracting them into vendor profiles is the next
step of ADR-0217 Phase 3.

The app wires the client in `lib/ai/agent/external/integrations/acp.ts`.
Checked by `node scripts/build/pack-test-agent-package.mjs agent-acp`.

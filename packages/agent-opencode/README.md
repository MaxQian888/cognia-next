# @cognia/agent-opencode

OpenCode integration (ADR-0217): the `opencode-v2` adapter over the current
OpenCode `/api` service (`./v2-client`, events in `./v2-events`), session-owned
loopback services for gateway tasks and Cognia MCP projection
(`./v2-launcher`), local service discovery (`./discovery`), the `opencode`
server adapter over `@opencode-ai/sdk` (`./client`) and the integration
manifest (`./manifest`).

Both adapters reach the network and the machine only through host ports: an
`AgentFetch` for every request and the event stream, an `AgentProcessHost` for
spawned services, the `AgentOutboundGate`, and, for V2, the host's placement
policy and service discovery (the desktop asks its sidecar; a host with a
process table runs `discoverOpenCodeV2InProcess`).

The manifest declares a turn-scoped interrupt on a shared service, native
resume and fork, and per-tool-call approvals. `./manifest` loads no runtime
code. `@opencode/client` and `@opencode-ai/sdk` are peer dependencies.

The app wires the adapters in `lib/ai/agent/external/integrations/opencode.ts`.
Checked by `node scripts/build/pack-test-agent-package.mjs agent-opencode`.

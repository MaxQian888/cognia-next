# @cognia/agent-a2a

A2A integration (ADR-0217): the `a2a` protocol adapter (`./client`: Agent Card
discovery, JSON-RPC `message/send` and `message/stream` over server-sent
events, `tasks/cancel`, protocol versions 0.3 and 1.0) and its semantics
(`./manifest`).

The adapter reaches the network only through the host's `AgentFetch` and runs
every outbound message through the `AgentOutboundGate`. A2A is a protocol, not
a vendor, so the manifest contributes protocol semantics and no ecosystem row.
`./manifest` loads no runtime code.

The app wires the adapter in `lib/ai/agent/external/integrations/a2a.ts`.
Checked by `node scripts/build/pack-test-agent-package.mjs agent-a2a`.

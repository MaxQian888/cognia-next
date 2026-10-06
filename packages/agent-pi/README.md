# @cognia/agent-pi

Pi integration (ADR-0217, ADR-0119): the `pi-rpc` protocol adapter
(`./rpc-client`), its strict LF frame peer (`./rpc-peer`), Pi-event mapping
(`./rpc-events`), the native-tool permission table the bundled Cognia Pi
extension applies (`./permission`), provider and credential probes (`./auth`)
and the integration manifest (`./manifest`).

The adapter runs one `pi --mode rpc` process per session and reaches the
machine only through host ports: an `AgentProcessHost`, `PiHostServices`
(bundled-extension verification and stored-session listing), the
`AgentOutboundGate`, the host's `AgentApprovalPolicy` and approval-list glob,
the operator kill switch and the plugin Pi-package resolver.

The manifest declares a turn-scoped cancel (`abort`), relaunch-with-session
resume, native fork, per-tool-call approvals and at most four processes.
`./manifest` loads no runtime code.

The app wires the adapter in `lib/ai/agent/external/integrations/pi.ts`; the
parity tests that pin `./permission` to the shipped sidecar extension live in
`lib/ai/agent/external/integrations/pi.test.ts`. Checked by
`node scripts/build/pack-test-agent-package.mjs agent-pi`.

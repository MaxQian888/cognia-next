# @cognia/agent-contracts

The contract between Cognia agent hosts and agent integrations (ADR-0217):
agent identity (`./ecosystem`), the external-agent wire, session and config
types (`./external-agent`, `./external-agent-lifecycle`), the adapter core and
its optional capabilities (`./adapter`), typed vendor extensions
(`./adapter-extension`), execution semantics (`./semantics`), host ports
(`./host`), the neutral history transcript (`./history`) and the canonical
event and session contracts.

Types plus a few pure helpers; no runtime dependency (the ACP SDK is a
type-only dependency, pinned exactly). Never imports host code.

```ts
import type { AgentProcessHost, AgentOutboundGate } from "@cognia/agent-contracts/host"
import { requiresReconnectAfterCancel } from "@cognia/agent-contracts/semantics"
```

Built with tsup to `dist/` (ESM + CJS + types) and checked by
`node scripts/build/pack-test-agent-package.mjs agent-contracts`. Overview:
`docs/content/docs/en/subsystems/agent-packages/`.

# @cognia/agent-aider

Aider integration (ADR-0217): the `aider-cli` protocol adapter
(`./cli-client`), the pure chat-history reader (`./history`) and the
integration manifest (`./manifest`).

The adapter runs one official Aider CLI process per turn with a Cognia-owned
chat, input and prompt file per session. It reaches the machine only through
host ports: an `AgentProcessHost` (raw-framed spawn, kill, command probe), an
`AgentFileHost` (confined workspace files and path containment), the
`AgentOutboundGate` every prompt, instruction, file context and restored
history passes, and an `AgentDiagnosticRedactor` for process output.

The manifest declares a turn-scoped cancel on a per-turn process, resume by
history replay (`--restore-chat-history`, never a native resume), no fork and
no approval channel. `./manifest` and `./history` load no runtime code.

```ts
import { aiderManifest } from "@cognia/agent-aider/manifest"
import { parseAiderHistory } from "@cognia/agent-aider/history"
```

The app wires the adapter in `lib/ai/agent/external/integrations/aider.ts` and
the reader in `lib/session-import/adapters/aider.ts`. Checked by
`node scripts/build/pack-test-agent-package.mjs agent-aider`.

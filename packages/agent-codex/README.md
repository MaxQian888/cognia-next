# @cognia/agent-codex

Codex integration (ADR-0217): the `codex-app-server` protocol adapter over a
host-provided process plane (`./app-server-client`, with the typed
`codexAppServerExtension` for vendor controls), Codex config requirements and
MCP projection, the pure Codex rollout history reader (`./history`), and the
integration manifest (`./manifest`).

The manifest declares a turn-scoped cancel on a shared process, native resume
and fork at a completed turn boundary. `./manifest` and `./history` load no
runtime or process code.

```ts
import { codexManifest } from "@cognia/agent-codex/manifest"
import { parseCodexRollout } from "@cognia/agent-codex/history"
```

The app wires the adapter in `lib/ai/agent/external/integrations/codex.ts` and
the reader in `lib/session-import/adapters/codex.ts`. Checked by
`node scripts/build/pack-test-agent-package.mjs agent-codex`.

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

## Native compatibility check

The opt-in test in `src/app-server-client.test.ts` runs the real CLI against
temporary MCP and loopback Responses fixtures. It generates the selected
binary's experimental schema and validates emitted client requests, then
checks streaming, token usage, cancellation and persisted thread operations.
It uses an isolated `CODEX_HOME` without inherited provider credentials.
The temporary config uses file-only credential storage; the test asserts no
credential headers, login/logout RPCs or temporary auth-file creation.

```sh
rtk env COGNIA_CODEX_LIVE=1 COGNIA_CODEX_BINARY=/absolute/path/to/codex pnpm exec jest --runInBand --runTestsByPath packages/agent-codex/src/app-server-client.test.ts
```

Omit `COGNIA_CODEX_BINARY` to test `codex` on `PATH`. Without
`COGNIA_CODEX_LIVE=1`, ordinary unit tests skip this native check. This is a
credential-free protocol check, not authenticated release certification.
The [2026-10-18 report](../../docs/reports/codex-app-server-2026-10-18/README.md)
records the tested versions, schema fingerprints and verification limits.

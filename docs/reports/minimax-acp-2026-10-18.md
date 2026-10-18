# MiniMax Code ACP integration — 2026-10-18

Scope: native stdio ACP only. App Server, SSH, vendor extension methods and native plugin management are excluded. Cloud authentication/model validation is deferred at the user's request.

## Upstream baseline

The inspected npm distribution is `@minimax-ai/code@0.6.12` (2026-10-15). Its changelog adds ACP image input/replay, App Server and local plugin subagents, plus improvements to compaction and cancellation. Cognia previously had generic ACP support without a MiniMax preset. This change adds the preset and the required vendor behavior; it does not expose every upstream feature.

## Permission contract

MiniMax separates process-wide permission configuration (`session/set_config_option`, `permissionMode`) from session interaction mode (`session/set_mode`, `default`/`plan`). A conversation therefore owns a distinct ACP process. Restore rotates the process and reapplies the requested policy; fork gets another process. Discovery carries no session MCP binding.

| Cognia selection    | MiniMax permission config | MiniMax interaction mode | Behavior                                                                                                                     |
| ------------------- | ------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `default`           | `default`                 | `default`                | Native policy; MiniMax may preapprove edits and classified shell operations. Cognia handles permission requests it receives. |
| `plan`              | `default`                 | `plan`                   | Native Plan; tested workspace write is blocked.                                                                              |
| `bypassPermissions` | `bypassPermissions`       | `default`                | Explicit native full access; OS sandbox remains active.                                                                      |
| `acceptEdits`       | —                         | —                        | Refused; native Auto can approve shell execution and is not edit-only.                                                       |
| `dontAsk`           | —                         | —                        | Refused; native preapproval prevents enforcing deny-unapproved behavior.                                                     |

Nonempty `requireApprovalFor` is refused before spawning: ACP 0.6.12 cannot force every matching native tool call through the host. Unsupported default/session policies fail before child launch. Native Auto is hidden. Mode changes are serialized, prompts wait for pending changes, active turns reject permission changes, and partial two-axis failures retire that process.

The real CLI investigation initially reproduced an unapproved workspace shell write under native Default. The fix is explicit refusal of incompatible policies, rather than claiming that routing native Default through Cognia can enforce them. Forcing approvals through native compatible hooks would require additional plugin/state wiring outside this scope.

## State and host integration

- System-owned runtime/preset `minimax-code`, executable `mcode acp`; absolute executable paths also bind to the runtime.
- Separate conversation transports and native MCP bindings, shared lifecycle implementation with Devin, and normal host privacy gates on outbound ACP frames.
- `MINIMAX_DATA_DIR` takes precedence over `MAVIS_DATA_DIR`; fallback is `~/.minimax`. Both aliases are normalized to the selected root. Image temporary files use its `tmp/` directory inside the host sandbox.
- CLI and Rust policy mirror the state root, reviewed environment keys, Bot containment checks and credential read-deny roots. No ambient credential prefix is broadly allowed.
- Setup text, ecosystem catalog, teammate label/badge and MiniMax brand alias are wired in both locales.

## Real local CLI verification

Run from the repository root after building the existing sandbox launcher:

```sh
rtk env COGNIA_MINIMAX_MCODE=/Users/bytedance/.cache/cognia/minimax-code/0.6.12/node_modules/.bin/mcode pnpm exec tsx scripts/smoke/minimax-acp-smoke.ts
```

The harness runs the actual fixed CLI through Cognia's Node host and native sandbox launcher, using temporary provider/session state, a deterministic local model endpoint and local MCP servers. It does not use a user login or a cloud key. It removes its sessions and scratch directory on exit.

Final output:

```json
{
  "result": "PASS",
  "cloud": false,
  "version": "0.6.12",
  "permissions": {
    "nativeDefaultPreapproval": true,
    "unclassifiedShellAsked": true,
    "unsupportedModesRefused": true,
    "planWriteBlocked": true,
    "fullAccess": true,
    "siblingUnchanged": true
  },
  "mcpIsolation": true,
  "lifecycle": { "load": true, "fork": true, "cancel": true, "resume": true },
  "requests": 27
}
```

Assertions include actual image bytes reaching the model endpoint, default-mode shell denial leaving no file, Plan blocking a workspace write, full access executing a shell write while the sibling still requires approval, independent MCP receipts, closing one session without stopping its sibling, persisted-session listing/load, fresh fork MCP scope, cancellation and resume.

## Other validation and limits

- Isolated commit regression: **19 suites, 861 passed, 1 existing skipped** (including per-execution permission downgrades and unsupported prompt overrides). The earlier shared-tree run included 4 tests from other sessions.
- `cargo test --locked -p cognia-external-agent --lib` on the isolated snapshot: **299 passed**. The earlier shared-tree run included 5 additional unrelated tests.
- Launcher Bot environment regression: **1 passed, 13 filtered out**.
- Additional ACP client regression: **282 passed**.
- Isolated full `pnpm lint`: **0 errors, 4 existing warnings** in the socket client, two virtualizer views and device rows; these files are unchanged by this commit. Staged-file lint/format and staged i18n checks pass.
- `@cognia/agent-acp` typecheck/build and packed ESM/CJS/NodeNext tests: passed (15 entry points, 5 data-only closures).
- Scoped ESLint, i18n build/freshness/parity, runtime/capability catalog audits and `git diff --check`: passed.
- The earlier full application checks in the shared tree encountered unrelated lint findings and 41 TypeScript diagnostics in remote-desktop, pet, subscription, sync and SDK work; none pointed to the MiniMax integration source paths. Those application checks are not a pass.
- No cloud provider, Windows/Linux runtime, full production app build, or Tauri UI acceptance is claimed. This is protocol/host integration verification on macOS. Commit preparation uses an isolated worktree with only MiniMax hunks; other sessions' shared-tree edits and staged work are preserved.

## Sources

The installed 0.6.12 distribution and its bundled changelog are the executable baseline. Official source was cross-checked on 2026-10-18:

- [npm distribution](https://www.npmjs.com/package/@minimax-ai/code/v/0.6.12)
- [ACP agent and config mutation](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/tui/src/acp/agent.ts)
- [ACP control axes](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/tui/src/acp/control-state.ts)
- [ACP startup options](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/tui/src/cli/run-acp-command.ts)
- [Native Bash permission policy](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/agent-modules/permission/src/tools/bash-permission.ts)
- [Native permission gate](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/local-runtime-v2/src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.ts)

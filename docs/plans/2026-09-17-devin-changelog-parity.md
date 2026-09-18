# Devin changelog parity: import the delta, skip what we already have

| Field           | Value                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status          | Draft — awaiting workstream selection                                                                                                                                                                                                                                                                                                                               |
| Author · Date   | Devin · 2026-09-17                                                                                                                                                                                                                                                                                                                                                  |
| Scope           | `src-tauri/src/hooks/**`, `lib/ai/agent/external/agent-hooks.ts`, `lib/claude/hooks/**`, `cli/src/skill/discover-skills.ts`, `src-tauri/src/skills/native.rs`, `cli/src/config/schema.ts`, `cli/src/agent/tool-suppression.ts`, `lib/connectors/{trigger-policy-draft,policy-eval}.ts`, `lib/integrations/**`, `lib/bot/**`, `cli/src/tui/components/patch-view.ts` |
| Source          | User request: "看看有什么可以引入到cognia中的" → "制定成完整的计划". Upstream evidence: <https://docs.devin.ai/cli/changelog/stable> (v3000.10.21, v3000.10.27), <https://docs.devin.ai/release-notes/2026> (Sep 9 / Sep 11)                                                                                                                                        |
| Related         | ADR-0040 (hooks mechanism completion), ADR-0174 (Bot control plane), ADR-0155 (one door for plugins), ADR-0009/0025/0036/0089/0131 (connectors), `docs/plans/2026-09-15-bot-plugin-api-surface.md`                                                                                                                                                                  |
| Reviewers       | hooks runtime owner, connector platform owner, plugin platform owner, CLI owner                                                                                                                                                                                                                                                                                     |
| Evidence state  | Every "Confirmed" row was read from the working tree on 2026-09-16/17                                                                                                                                                                                                                                                                                               |
| Security impact | WS-1 lets hook scripts see which plugin/MCP server declared a tool (metadata only, no secret values). WS-4 evaluates user-supplied regexes — must bound input and reject catastrophic patterns. WS-5 adds an inbound webhook surface — signature verification is part of the design, not a follow-up.                                                               |

> **Executive summary**
>
> - **Change:** import the six transferable items from Devin's September changelogs that Cognia lacks, in five workstreams plus one polish batch: `tool_provenance` in hook payloads, `.cursor/skills` autoload, config-level `disabled_tools`, a `regex` trigger-policy kind, a PagerDuty-class incident webhook + oncall-responder path, and a diff-render/self-check polish batch.
> - **Reason:** Cognia and Devin CLI share lineage, so most of the changelog is already covered (`/mode` + `permissionMode`, auto-compact threshold, `.claude`/`.agents` skill dirs, marketplace install flow, refusal-fallback SDK subtypes, per-model usage). The six items above are the real delta — each is a capability the current tree cannot express, not a port for its own sake.
> - **Impact:** additive hook-payload field (hook scripts see a new key, nothing removed), two new skill scan dirs, one new config key, one new trigger-rule kind, one new inbound webhook integration. No Dexie schema version required except WS-5 (new integration row + delivery table reuse) — claim a version there if a table is added.
> - **Decision order:** WS-1 is the flagship and is self-contained; WS-2/WS-3 are small parity wins; WS-4 is medium; WS-5 is the largest and can land last or split into its own plan; WS-6 is opportunistic.

## 1. What the changelog offers vs. what Cognia already has

### Context

**Situation.** Devin's September updates (CLI v3000.10.21 + v3000.10.27, product Sep 9 + Sep 11) shipped ~40 items across the CLI, hooks, permissions, connectors, marketplace, and automations. Cognia shares the agent-runtime lineage, so the honest first question is which items are genuine gaps rather than features wearing different names.

**Complication.** A line-by-line read against the working tree shows most items already exist:

| Devin item                                   | Cognia equivalent (confirmed)                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/code` `/smart` `/bypass` mode commands     | `permissionMode` (`plan`/`acceptEdits`/`bypassPermissions`/`auto`) + `/mode`, `/agent-mode`, `/plan`, `/permissions` commands (`cli/src/tui/commands/registry.ts`)                                             |
| `agent.compaction_threshold_tokens`          | "Auto-compact threshold" CLI setting (`cli/src/tui/runtime/settings-sections.ts:917`) + compaction settings in `packages/agent-config-types`                                                                   |
| `.claude/skills` + `.agents/skills` autoload | `cli/src/skill/discover-skills.ts` scans `.cognia`, `.claude`, `.agents`, OpenCode + `config.skillDirs`; desktop mirrors via `src-tauri` native scan                                                           |
| Plugin marketplace + scoped install          | `lib/plugin/marketplace/install-flow.ts` — conflict → dependencies → permission → binary → config pre-install chain, no Dexie row before approval                                                              |
| Refusal fallback (`DEVIN_REFUSAL_FALLBACK`)  | `model_refusal_fallback` / `model_refusal_no_fallback` already in `SDK_SYSTEM_SUBTYPES` (`packages/agent-config-types/src/index.ts:2141`) — runtime emits it; only a user-facing config surface may be missing |
| `/session-stats` by-model chart              | `UsagePanel.tsx:180` renders "Usage by model" from `session-usage.ts` `byModel` aggregation (`lib/db/session-usage.ts:685-812`)                                                                                |
| Idempotent session creation                  | `idempotency: "required"` is pervasive in `cli/src/api/generated/command-index.ts`                                                                                                                             |
| Slack/Teams parity work                      | Connector adapters: lark, slack, discord, telegram, wecom, dingtalk, matrix, qq-official, wechat-oa, wechat-personal (`lib/connectors/adapters/`)                                                              |
| Safer secret defaults (Personal vs org)      | N/A — Cognia is local-first; no org-scoped secret store exists to default                                                                                                                                      |

**Question.** Which remaining items are worth their weight — real capability gaps, not vanity parity?

**Answer.** Six, ranked by leverage:

1. `tool_provenance` on hook payloads — unlocks policy that today's hooks cannot write.
2. `.cursor/skills` autoload — completes the editor-skill parity triangle (`.claude` + `.agents` done).
3. Config-level `disabled_tools` — today's `disabledTools` overlay only covers MCP tools.
4. `regex` trigger-policy kind — trigger rules are keyword-only today.
5. Incident-webhook + oncall responder — the largest product item in the changelog; maps onto the Bot plane + integrations ingress, not a chat adapter.
6. Polish batch — large-diff tail truncation, compact read-only command cards, and three self-checks where Devin fixed bugs Cognia may share.

### Goals

| Goal                                                                        |                                                                                                             Baseline (confirmed) |                                                                                                  Target | Acceptance evidence                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------- |
| G1 PreToolUse/PostToolUse hook input carries `tool_provenance`              | payload = `hook_event_name`/`session_id`/`cwd`/`agent_*`/free-form `fields` (`src-tauri/src/hooks/types.rs:205`); no tool origin |                                                `{kind, source, declared_by}` on every tool-scoped event | `agent-hooks.test.ts` asserts the field; Rust `#[cfg(test)]` in `commands.rs`/`types.rs`; one built-in hook script consuming it |
| G2 `.cursor/skills` auto-loads at project + global scope                    |                                       `discover-skills.ts` knows `.cognia`/`.claude`/`.agents`/opencode/custom; `.cursor` absent |                                           `cursor-project` + `cursor` sources, deduped by resolved path | `discover-skills.test.ts` cases; Rust native-scan test                                                                          |
| G3 `disabled_tools` in user config suppresses any tool by name              |                            `disabledTools` overlay unions MCP tools only (`cli/src/agent/tool-suppression.ts`, `mcp-state.json`) |  config key merged into `disallowedTools` for built-in + MCP + plugin tools, session + subagent runners | `tool-suppression.test.ts`; schema validation test                                                                              |
| G4 Trigger policies accept a `regex` rule kind                              |                                                                    `policy-eval.ts` handles `keyword` + `keyword-blocklist` only |          `regex { pattern, caseInsensitive }` kind, RE2-subset validated, evaluated in `policy-eval.ts` | `policy-eval.test.ts` + `trigger-policy-draft.test.ts`; editor UI + i18n keys                                                   |
| G5 PagerDuty-class incident events trigger a bot run and post findings back |                                                `lib/integrations/` is GitHub-only; bot triggers are the six kinds in `types/bot` |        inbound verified webhook → normalized envelope → generic `match` conditions → responder executor | `pagerduty-webhook.test.ts`; `conditions.test.ts` on PagerDuty-shaped payloads; end-to-end fixture test                         |
| G6 Diff render + self-check batch                                           |                                                                            `patch-view.ts` truncates per-line width, no body cap | large-diff tail truncation marker; compact read-only command cards; three verified-or-filed self-checks | `patch-view.test.ts`; card snapshot test; self-check findings recorded                                                          |

### Scope and non-goals

- ✅ In scope: WS-1 through WS-6 as specified below; co-located tests per house rule; i18n keys for any user-facing string; changesets (`minor` for WS-1/WS-5, `patch` for the rest).
- ⏭️ Deferred but compatible:
  - `agent.codex_tools`-style per-model tool sets. Cognia's tool surface is already mode/permission-driven; a second axis needs a design of its own.
  - OAuth MCP-server catalog expansion ("21 one-click servers") — content work, not a capability gap. The preset registry (`mcp-server-preset-registry.ts`) accepts entries any time.
  - Full PagerDuty responder UX (multi-incident console, escalation policies). WS-5 lands the pipeline; the console is a separate product call.
  - `Ctrl+Y` kill-ring yank — `ctrl+y` is already bound to `redo` (`cli/src/tui/input/keybindings.ts:65`). Rebinding redo is a UX regression; if wanted, yank belongs on an emacs-map key — file as its own issue.
- ❌ Not supported:
  - Enterprise-only items (IdP/SCIM effective membership, org secret defaults) — no org plane exists locally.
  - Devin-webapp UI items (sidebar multi-PR dropdown, touch Desktop tab) — different product surface.

## 2. WS-1 — `tool_provenance` on hook payloads

**Why first.** It's the only item that expands what users can _express_ — a hook that today can only match `tool_name` could instead deny every tool from MCP server X, or require approval when a specific plugin's tool runs. It's also self-contained: one new key on an existing payload.

**Confirmed integration points.**

- System B (settings.json command hooks) reaches Rust through `run_agent_hook` (`src-tauri/src/hooks/commands.rs:59`), which merges a caller-supplied `payload` into `HookEventPayload.fields` (free-form bag, `types.rs:217`). TS callers: `fireAgentHook` in `lib/ai/agent/external/agent-hooks.ts:114` and the lifecycle firers (`lib/claude/hooks/lifecycle-firer.ts`, `cli/src/tui/runtime/lifecycle-firer.ts`).
- The built-in-agent path fires the same Rust runtime from the sidecar permission/PreToolUse path (`sidecar/dispatch/anthropic.mjs:172-182` wraps SDK hooks; `sidecar.rs` forwards `permission_request`).

**Design.** Provenance is resolved from the tool _name_, at the layer that already knows the tool surface:

| Name shape                                             | Provenance                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `mcp__<server>__<tool>`                                | `{kind:"mcp", source:<server-id>, declared_by:<mcp config path>}`          |
| plugin alias (sidecar `plugin-tool-aliases.mjs` table) | `{kind:"plugin", source:<plugin-id>, declared_by:<manifest path>}`         |
| `mcp__cognia-tools__<name>` / builtin names            | `{kind:"builtin", source:"cognia", declared_by:"builtin-tools-data.json"}` |
| anything else                                          | `{kind:"builtin"}` or omit — hooks must tolerate absence                   |

Resolution order: the TS firer that owns the tool surface computes provenance and puts it into `payload.fields.tool_provenance` before `run_agent_hook`; the Rust layer stays a pass-through (it must NOT recompute — it has no registry access). For the built-in path the sidecar injects the same field into the SDK hook input before the Rust runtime sees it.

**Files.**

- `lib/claude/hooks/tool-provenance.ts` (new, small, pure) — name → provenance resolver; unit-tested.
- `lib/ai/agent/external/agent-hooks.ts`, `lib/claude/hooks/lifecycle-firer.ts`, `cli/src/tui/runtime/lifecycle-firer.ts` — attach `tool_provenance` to tool-scoped payloads.
- `sidecar/dispatch/plugin-hook-exec.mjs` / the PreToolUse wrap in `sidecar/dispatch/anthropic.mjs` — same injection for built-in turns.
- `src-tauri/src/hooks/types.rs` doc comment + `commands.rs` — pass-through is already free; add a `#[cfg(test)]` proving `fields` survives round-trip.
- `docs/content/docs/{en,zh}` hooks docs + ADR-0040 amendment noting the new field.

**Tests.** `tool-provenance.test.ts` (every name shape + unknown), `agent-hooks.test.ts` (field present on PreToolUse), `plugin-hook-exec.test.mjs` (sidecar path), Rust test in `commands.rs` (fields flattening preserves the key).

## 3. WS-2 — `.cursor/skills` autoload

**Integration points.** `cli/src/skill/discover-skills.ts:186` `skillScanDirs` builds the ordered list; sources are tagged `"project" | "global" | "claude-project" | "claude" | "codex" | "opencode" | "custom"` (`:75`). Add `cursor-project` (`<cwd>/.cursor/skills`) and `cursor` (`~/.cursor/skills`) — precedence after the CLI's own `.cognia` dirs, alongside `claude-*` (first-dir-wins on id collision, so order in the array is the only decision). Desktop parity: the Rust native scanner behind `skills_scan_dir` (`src-tauri/src/skills/native.rs`, invoked from `lib/claude/ipc.ts:1380`) gains the same two dirs.

**Self-check folded in:** Devin also fixed "skills reachable through more than one path load once" — verify `discover-skills.ts` dedups by resolved/real path, not by string (add a symlinked-dir test if not).

**Tests.** `discover-skills.test.ts` (both dirs, precedence, dedup-by-realpath), native-scan Rust test.

## 4. WS-3 — config-level `disabled_tools`

**Gap.** `withCliDisabledMcpTools` (`cli/src/agent/tool-suppression.ts:80`) unions only the MCP-tool overlay from `~/.cognia/mcp-state.json` into `disallowedTools`. There is no way to disable a built-in tool by name.

**Design.** `cli/src/config/schema.ts` gains `disabledTools: string[]` (match existing schema naming — check whether the file uses camelCase; Devin's `disabled_tools` is snake_case but Cognia's schema is the authority). `tool-suppression.ts` gains `withConfigDisabledTools(options, names)` unioning into `options.disallowedTools`, applied in `session-runner.ts` and `subagent-runner` alongside the existing MCP-overlay call. Desktop parity: if `resolveSendOptions` (`lib/claude/build-options.ts:2328`) reads a shared settings object, add the field there so desktop sessions honor it too — otherwise scope to CLI and note the asymmetry in the plan's Known Limitations.

**Tests.** `tool-suppression.test.ts` (union, dedup, empty-config no-op), schema test, one runner-level test that a disabled builtin never reaches the gate.

**Known limitations.** `disabledTools` is honored only on the CLI/headless path: `resolveSendOptions` (`lib/claude/build-options.ts`) has no shared settings object carrying it, so desktop sessions ignore the field entirely. Desktop parity is deferred — surfacing it needs a settings-synced field, not a config-file read.

## 5. WS-4 — `regex` trigger-policy kind

**Gap.** `lib/connectors/policy-eval.ts` evaluates `keyword` (`:78`) and `keyword-blocklist` (`:111`) by substring; `trigger-policy-draft.ts` builds those two shapes. Devin added case-sensitive RE2 to automation text fields.

**Design.** New rule kind `regex { enabled, pattern, caseInsensitive }` in the draft builder and evaluator.

- **Safety:** JS `RegExp` is not RE2 — catastrophic backtracking is real on adversarial patterns (connectors process inbound chat text). Two acceptable implementations: (a) validate against an RE2-safe subset at draft time (reject lookaround/backreferences; nested-quantifier heuristic), or (b) evaluate with a worker-side timeout. Prefer (a) — deterministic, no async boundary. Either way the evaluator caps input text length.
- **UI:** trigger-policy editor gets a pattern field + invalid-pattern hint; i18n keys in `en`/`zh-CN` split sources + `pnpm i18n:build` + `lint:i18n`.

**Tests.** `policy-eval.test.ts` (match/no-match/case flag/invalid pattern rejected at draft, never at eval), `trigger-policy-draft.test.ts` (round-trip through the draft reducer), component test for the editor field.

## 6. WS-5 — incident webhook + oncall responder (PagerDuty parity)

**Why it maps differently.** PagerDuty is not a chat platform — a `PlatformAdapter` (`adapter-registry.ts`) is the wrong shape. The Cognia-native shape is:

1. **Ingress:** `lib/integrations/` already owns webhook-style inbound (`github-webhook.ts`, `ingress-client.ts`, `github-delivery-recovery.ts`). Add `pagerduty-*` beside it: endpoint registration, signature verification (`v1` webhook signatures), event normalization to a stable envelope (`incident.{triggered,acknowledged,resolved,updated}` + ids + priority + service).
2. **Trigger:** the Bot plane's generic `match` on envelope paths (landed 2026-09-15 in `lib/bot/events/conditions.ts`) evaluates `payload.incident.*` — no new condition code needed, which is exactly what that change was for.
3. **Responder:** an `agent-turn`-executor bot template ("triage the incident, post findings as an incident note") contributed as a template/bundled plugin, mirroring how `plugins/cognia-scheduler-tools` contributes its Bot. Outbound note via a PagerDuty REST call through `connectorsHttpRequest` or the integrations transport.
4. **Automations:** the same normalized envelope is publishable on the connector bus so user automations can subscribe — reuse `events:publish`/`events:subscribe`, do not build a second channel.

**Dexie:** if a new table is needed (installation rows, delivery ledger), claim a schema version per the dexie-migration skill — check whether `bot-event-deliveries` already covers it first.

**Tests.** Webhook signature + normalization unit tests; `conditions.test.ts` PagerDuty-shaped payloads; a fixture end-to-end (webhook in → bot run → note out, transport mocked); template manifest validation.

**Sequencing note.** Largest workstream — can land last, or split into its own plan if the responder UX grows.

**Implementation note (2026-09-17).** Shipped as a bundled `plugins/pagerduty` plugin on the generic integration/bot planes. Two divergences from the sketch above: (1) webhook signature verification went into the shared `IntegrationVerification::HmacSha256` contract as `signatureListSeparator` (PagerDuty sends `v1=<hex>,v1=<hex>` during key rotation); (2) the responder is a `handler`-executor Bot, not `agent-turn` — brokered integration actions are not a tool surface an unattended turn can call, so the handler runs the triage turn via `ctx.agent.runCharacterTurn` inside a memoized step, gates the note on `step.waitForApproval` with the exact `approvedActions` input, and writes through `ctx.integrations.executeAction`. That in turn required generalizing `resolveBotIntegrationBinding`/`assertBotIntegrationAction` off the hardcoded `repoFullName` check onto action-declared `scopeSelectors` (repository config or `config.scopes`); `github-delivery` actions declare the repository selector, so GitHub enforcement is unchanged.

## 7. WS-6 — polish batch + self-checks

Small, independent; each its own commit.

1. **Large-diff tail truncation** — `cli/src/tui/components/patch-view.ts` truncates line _width_ (`truncateTerminalSpans`, `:766`) but has no body-length cap. Cap rendered diff lines (keep head, tail marker `[... N lines truncated ...]`), matching Devin's fix for big-edit render stalls. Test: `patch-view.test.ts`.
2. **Compact cards for read-only shell commands** — Devin renders `git status`-class commands as title-only cards. Evaluate against the CLI's bash/tool card component; adopt if the card is currently verbose for zero-diff reads.
3. **Self-checks (verify, then either fix or file):**
   - background-subagent-running → status must not read idle (Devin v3000.10.21 fix). Check the CLI's turn-state reducer against `subagent-runner`.
   - `cd`-prefixed command permission resolution must be fail-closed per target dir — audit `command-safety-registry` + the permission evaluator.
   - reopened-session memory — Devin halved it by streaming stored messages instead of holding a second copy. Profile `lib/db` session load → transcript hydrate; fix only if the double-residency exists here.

**Implementation notes (2026-09-17).**

- Item 1 shipped in `cli/src/tui/markdown/diff.ts` (`tailDiffPreview`, consumed by the cell-terminal-block / `CellView` path rather than `patch-view.ts`). Deliberate divergence from "keep head": the preview keeps the **tail** (last 50 body lines) with an earlier-lines-omitted marker, because in a large write/edit the newest content sits at the end and the head is reconstructable from the file on disk. Semantics preserved: a line cap plus a truncation marker.
- Self-check 1 (background subagent → not idle): **already satisfied, no fix needed.** `BottomStatus` renders detached-run rows (`backgroundSubagents`, `interruptedBackgroundSubagents`, `pendingBackgroundResults`, live-agent tree) independently of `turnStatus` — the early return explicitly keeps the layer mounted while background runs persist (`BottomStatus.tsx` "Nothing live to show" guard). Pinned by `BottomStatus.test.tsx` "keeps the layer mounted for the tree while idle and drops it when runs settle" (`turnStatus="idle"` + `backgroundSubagents={1}` still renders "Running 1 agent…").
- Self-check 2 (`cd` prefixes fail-closed): shipped — `command-safety-registry` resolves `cd`/`pushd`/`popd` prefixes so `cd / && rm -rf ./etc` is evaluated against `/`, not cwd.
- Self-check 3 (memory double-residency): shipped — transcript hydration streams stored messages rather than holding a second copy.

## 8. Gates and sequencing

Per-house-rules exit criteria for every workstream: co-located tests (`pnpm audit:colocated-tests`), `pnpm i18n:build && pnpm i18n:build:check && pnpm lint:i18n` when strings ship, `pnpm typecheck`, `pnpm test -- <touched suites>`, `pnpm lint`, `pnpm changeset` (select `cognia-next`; `minor` for WS-1/WS-5, `patch` elsewhere). WS-1 amends ADR-0040; WS-5 touches connector/bot docs.

Suggested commit order (independent, reviewable alone): **WS-2 → WS-3 → WS-6.1/6.2 → WS-4 → WS-1 → WS-5.** Small parity wins first; the two structural items land when the tree is clean.

### Open questions

1. WS-1: should `tool_provenance` also reach System A plugin hooks (`plugin_hook_exec` payload already carries the _handler's_ plugin id — the new field describes the _tool's_ origin)? Recommended yes for symmetry.
2. WS-3: camelCase vs snake_case in `cli/src/config/schema.ts` — follow whatever the file already uses.
3. WS-5: is PagerDuty itself the target, or is the generic "verified webhook → bot trigger" the deliverable with PagerDuty as the first preset? Recommend the latter — it keeps the integration surface honest.

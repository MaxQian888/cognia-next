# WebCodex evaluation and External Bridge roadmap

Researched 2026-09-29. Three parallel investigations covered `yyjeqhc/webcodex`
@ 0.4.3 (Apache-2.0, studied from a local clone) and cognia-next HEAD: WebCodex
architecture, its model-facing tool surface and distribution, and Cognia-side
integration seams. Every load-bearing claim below was re-verified against source
before writing this plan.

## Verdict

Do **not** vendor WebCodex and do **not** ship it as a plugin. Cognia already
owns the safer half of the pattern — the External Bridge is a scope-gated MCP
server with per-client credentials, constant-time bearer checks, DNS-rebinding
defense and revocation. WebCodex's transferable value is its model-facing
protocol discipline, not its topology: `webcodex-runner` duplicates
`cognia-files` / `cognia-git` / `cognia-terminal` / `cognia-jobs` /
`cognia-local-browser` / `cognia-skills`, and vendoring it would create a second
audit/permission plane and violate the ADR-0196 layer gates.

A plugin cannot own this feature either: the permission vocabulary
(`packages/plugin-sdk/src/contracts/generated.ts`) has no `network:listen`/`bind`
capability — all network permissions are outbound-only. Plugins may contribute
tools through `plugin_tool_invoke` but must not own listeners or credentials
(ADR-0155, one host door).

## Verified facts

Cognia side:

- `crates/cognia-mcp-server/src/http_server.rs:245` binds `127.0.0.1` only;
  Host/Origin loopback enforcement at `:344-378`; per-client SHA-256 verifiers,
  scopes, expiry, revoke-closes-sessions.
- `crates/cognia-companion/src/external_bridge.rs:214-220` rejects
  `bind_mode != "loopback"` and `auto_start` with `REMOTE_FEATURE_UNSUPPORTED`;
  the TS type already models `"loopback" | "relay" | "direct-tls"`
  (`lib/external-bridge/tauri-control.ts:42`). The seam is designed, not built.
- `BridgeScope` vocabulary + `DEFAULT_ENABLED_SCOPES = ["wiki:cognia",
"rag:cognia"]` at `types/wiki/index.ts:37,152,187`.
- `protocol/companion-commands.json` already exposes ~14 `fs_*_workspace`
  commands, `fs_workspace_roots`, and a large `task_workspace_*` family —
  bounded workspace access exists, just not as MCP tools.
- `cognia-companion-connectivity` already implements tunnel.rs / signaling/ /
  mesh.rs / tls.rs — the outbound relay lane WebCodex needs a Runner for is
  built, unattached to MCP.
- `externalBin` precedent for shipping Rust binaries: `cognia-server`,
  `cognia-external-agent-launcher` (`src-tauri/tauri.conf.json:44`).

WebCodex side:

- ~220 `ToolDefinition`s across 26 files in
  `crates/webcodex-tool-contracts/src/tool_definition/`; adaptive surface = ~23
  direct-ranked tools + `call_runtime_tool` gateway
  (`src/mcp/tools.rs:80`, `src/model_surface.rs`).
- `execution_state=pending` + `continuation` handoff contract is real
  (`src/tool_runtime/jobs.rs`, ~70 references); passive `job_attention` sidecar
  at `src/tool_runtime/job_attention.rs`.
- `is_secret_path` vs `is_bulk_excluded_path` split
  (`crates/webcodex-core/src/sensitive_paths.rs:56,74`); process-group cleanup
  with pgid-reuse guard (`crates/webcodex-process/src/unix.rs:24-58`).
- All 8 unified installer variants marked "Not yet accepted on a real machine"
  (`docs/unified-deployment-validation.md:56-63`); single-maintainer project
  (~4 months, one dominant committer); crates unpublished, path-deps only;
  Apache-2.0, no NOTICE file.

## Phases

### Phase 0 — product decision gate (blocks Phase 3 only)

Decide whether "cloud MCP clients (ChatGPT/Claude) reach this machine" is a
product capability at all. This reopens the remote-exposure decision deferred
in ADR-0008. If no, Phases 1–2 still stand on their own: they only strengthen
the existing loopback bridge.

### Phase 1 — absorb protocol discipline (no topology change)

Adopt WebCodex's model-facing contract rules inside Cognia's own tool/result
surfaces. Re-verification pass found these are extensions of existing
substrates, not new machinery — do not reimplement:

- **Pending/continuation envelope** — genuinely absent: `JobStatus` is
  `{Running,Exited,Killed,Interrupted,Failed}` (`crates/cognia-jobs/src/types.rs:57-91`)
  with no pending/continuation vocabulary. Add
  `execution_state=pending` + `continuation:{tool, arguments}` to the existing
  `ToolEnvelope` (`server.ts:1125-1153` already carries `structuredContent` /
  `isError` / `code`; `runWithGate` at `:2480+` already normalizes denials).
  Extend that envelope — do not add a parallel result shape.
- **Passive attention sidecar** — build on the existing `job:exited` scheduler
  event (`types.rs:173`, `lib/scheduler/event-integration.ts:128`) as the
  change feed; add only the piggyback delivery + cursor dedup + byte cap onto
  ordinary tool results (model on `src/tool_runtime/job_attention.rs`). No new
  event infrastructure.
- **Sparse success / decision-complete failure** — vocabulary-level addition:
  `reason_code`/`failure_stage`/`state_changed`/`outcome_unknown` plus at most
  one follow-up with explicit `mechanically_followable` posture, on top of the
  existing `code` field convention.
- **Turn economy** — clamp out-of-range ergonomic inputs and report the
  effective value; keep fail-closed for identity/fence/authority. Applies to
  handler arg validation, no new layer.
- **Sensitive-path predicate** — Cognia already has `SENSITIVE_FILE_NAMES`
  (`crates/cognia-files/src/files.rs:1118`, covering `.env`/`.envrc`/`id_rsa`
  etc.). The WebCodex delta is the _split_: always-deny secrets (`.git`
  internals, `*.pem`/`*.key`, credential files) vs. bulk-excluded trees
  (`target`, `node_modules` — skipped in scans, still readable individually).
  Extend the existing list and add the two-tier semantics; do not add a second
  guard.
- **Process-tree ownership** — `cognia-jobs` already puts each child in its own
  session/group and tree-kills it (`supervisor.rs:146-154`,
  `kill_reaps_the_whole_process_group` test at `:612`). The only delta to
  verify is the pgid-reuse window: WebCodex's `tree_exited` sticky flag
  prevents signalling a pgid that may have been recycled. Audit whether
  `killed: Arc<AtomicBool>` (`supervisor.rs:183`) closes that window; add the
  guard only if it doesn't.
- **Tool-definition-owned audit projection** — today `permission-gate.ts` +
  `audit-log.ts` apply a uniform audit path; the WebCodex rule (each tool
  declares its audit projection; unprojectable → empty object, never raw
  params) should land as a per-tool audit hook on the existing gate, not a new
  audit pipeline.

Each item lands with a co-located test; no new crates required.

### Phase 2 — workspace tool surface on the loopback bridge

Register dev-machine primitives as MCP tools in
`lib/external-bridge/mcp-server/server.ts` — verified gap: 43 `registerTool`
calls today, zero file/git/shell/job/workspace tools. Behind new default-OFF
scopes (e.g. `workspace:read`, `workspace:write`, `git:read`, `shell:run`,
`jobs:run`), routed to the same host surfaces as companion RPC — no new
execution layer:

- Workspace files: `lib/files/workspace-fs.ts`, `confined-ops.ts` (confined
  writes), `allowed-roots-sync.ts`, `secure-fs.ts`, `audit.ts` — the bounded-fs
  stack already exists and is tested; the MCP tools are thin registrations.
- Git: `cognia-git` + `rpc/source_control.rs` companion surface.
- Shell/jobs: `cognia-terminal` (PTY) + `cognia-jobs` (non-PTY supervisor),
  fronted by `lib/claude/permissions/command-safety.ts` `classifyCommand`.
- Workspace identity/boundary: `task_workspace_*` + `fs_workspace_roots`.

Hard rules:

- Never expose raw absolute-path file commands (the CONTROL-gated
  `read_text_file`/`write_text_file` family) — only root-relative workspace
  variants and confined writes.
- Shell/job tools reuse `lib/claude/permissions/command-safety`
  `classifyCommand` plus consent, not a global auto-approve switch.
- Credential-to-project scoping: a bridge client sees only its granted
  workspace roots (WebCodex ProjectGrant analog).

Deliverable: Claude Desktop / Cursor / other local MCP clients can drive real
file/git/shell/job work on this machine — still loopback-only.

### Phase 3 — remote reachability via relay (gated on Phase 0)

Unblock `bind_mode="relay"`: terminate remote MCP on the existing
`cognia-companion-connectivity` relay/WebRTC lane (outbound only, no listening
port — the WebCodex Runner topology) instead of opening `direct-tls`.
Prerequisites: host secure-storage preflight (the auto-start blocker at
`external_bridge.rs:217-220`), relay-side identity/TLS scheme, ADR-0008
amendment, per-device grants mapping (`cognia-companion-security` `GrantKind`)
extended to bridge scopes.

### Phase 4 — optional follow-ons

- External-agent observation: replicate `integrations/codex` — PostToolUse-style
  hooks from local agent CLIs feeding a `record_external_observation`-style
  hidden tool into Cognia session evidence.
- Plugin contribution alignment: first-party plugins may expose workspace tools
  through `plugin_tool_invoke` under the same new scopes.

## Explicitly rejected

- Vendoring `webcodex-runner`/`webcodex-server` (duplicates existing crates;
  second audit plane; path-dep-only workspace; single-maintainer upstream).
- Plugin-owned listener/credentials (no permission exists; ADR-0155).
- `trusted_agent|restricted` global authority mode (Cognia's per-scope + consent
  model is finer; a global switch would regress it).
- `wc_*` credential family, `agent:<client>:<project>` addressing, Durable
  Agent/Conversation/Wake domain (overlap with Cognia companion/device/agent
  systems).
- Running upstream binaries via `externalBin` (feasible per
  `tauri.conf.json:44`, but imports an unverified installer story and a
  parallel security model).

## Risks and open questions

- Phase 3 is a security-boundary change, not a feature add — requires the
  ADR-0008 revisit and a relay identity design before any code.
- Workspace MCP tools widen the local attack surface; every tool must round
  through existing consent/scope gates and workspace-bounded filesystem calls.
- WebCodex's docs↔code drift and unverified platform acceptance mean its
  operational claims should not be treated as proven.
- Apache-2.0 obligations if any code is copied: retain license headers,
  note modifications, do not reuse the WebCodex name/brand assets.

## Implementation status (2026-09-29)

Implemented as [ADR-0203](../content/docs/en/adr/0203-external-bridge-workspace-tools.md).
Re-verification against the code corrected four premises of this plan:

- **Phase 2 is not "thin registrations".** The local `fs_*_workspace` commands
  trust any absolute root from the renderer, and `SENSITIVE_FILE_NAMES` only
  hides credentials from `fs_walk_workspace` (reads and searches return them).
  The bridge therefore resolves roots by `WorkspaceRoot.id` against a
  per-client grant (`workspaceGrants`) and applies its own two-tier path
  policy on every tool.
- **No pgid guard is needed.** `cognia-jobs` signals a group only while its
  leader is unreaped, from the task that owns the child. (A separate leak —
  terminal jobs never leave the supervisor's live map — is tracked on its own.)
- **`jobs:run` folds into `shell:run`.** Every command is a supervised job.
- **Phase 4 "external-agent observation" already exists** as ADR-0062 live
  session import; no hook-fed tool was added. Plugin alignment was implemented:
  `plugin_tool_invoke` requires the workspace scope matching each
  filesystem/process manifest permission.

Phase 3 (relay reachability) is not implemented: it stays gated on the Phase 0
product decision and an ADR-0008 amendment.

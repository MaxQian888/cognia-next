# Companion RPC ↔ Tauri semantic parity audit

**Date:** 2026-08-15
**Scope:** the Companion dispatch funnel — everything downstream of
`remote_execution::execute` (HTTP, WebSocket, WebRTC, ACP, A2A, headless).
The CLI ↔ App stdio bridge (ADR-0078) is a separate audience and threat model
and is out of scope.
**Frame:** ADR-0013 stands. The remote surface is a curated subset, not a 1:1
mirror. This audit does not challenge that; it asks two questions the existing
gates never ask:

1. Of the commands that ARE exposed, is the exposure semantically complete?
2. Of the commands that are NOT, is the exclusion actually justified in writing?

**Supersedes the coverage numbers in**
`headless-remote-deployment-gap-analysis-2026-07-19.md` (441/611 → now 493/593).

---

> **Remediation status (2026-08-15, same day).** The P0s below are fixed and
> verified by `real_client_payloads_pass_the_enforced_input_contract` in
> `src-tauri/src/companion_api/remote_execution.rs`, which validates payloads
> copied from the real call sites and failed on all of them when written. The
> break was **wider than this audit originally found** — see
> "Correction: the casing class" — and the gate baseline went 80 → 61.
>
> The event axis (§2) is now fixed too, in the required order: per-connection
> subscription and audience filtering first
> (`src-tauri/src/companion_api/event_channels.rs`), then the allowlist widened
> from 18 to a 70-entry catalog (25 on by default, 45 opt-in). Building it
> corrected §2 twice — see "Correction: the event axis".
>
> The 59 untriaged commands are triaged, each with a descriptor and a
> per-command written reason (§6), and the `covered-by-headless` class was
> verified family by family (§9). **The gate baseline is now 0** — every gated
> finding class is clean, so the ratchet has nothing left to forgive.
> Outstanding: five commands recorded as `unexposed-gap`, which is a decision
> for a human, not an omission.

## The one-line finding

Every gate in this repo compares **command name sets**. Nothing compares
argument shapes, event channels, or error structure — and the schemas that
_are_ enforced at runtime were hand-written or derived from the truncated side
of the boundary, so they ratify losses rather than detect them.

Concretely: **8 dispatch arms silently drop arguments**, **~77 of ~84 event
channels never reach a remote client**, and **63 of 64 `git_*` commands are
hard-broken on every companion transport**.

---

## Inventory

| Artifact                                                  |  Count |
| --------------------------------------------------------- | -----: |
| `#[tauri::command]` registered in `generate_handler!`     |    940 |
| `KNOWN_COMMANDS` (RPC dispatch allowlist)                 |    493 |
| Dispatch arms across the 10 `rpc/*.rs` submodules         |    462 |
| `protocol/companion-commands.json` descriptors            |   1066 |
| `protocol/headless-command-dispositions.json` entries     |    593 |
| Distinct Rust event names emitted (statically resolvable) |    ~84 |
| Event names forwardable to a remote client                | **18** |

Reproduce with `pnpm audit:rpc-semantic-parity:report`.

---

## Findings, ordered by user-perceivable breakage

### P0 — Silent failure / total loss of function

#### 1. `git_*`: 63 of 64 commands are dead on every companion transport

Remote source control is entirely non-functional. A paired device can call
`git_workspace_list` and nothing else.

The client is _required_ to send the workspace-scoped shape —
`lib/git/commands.ts:65` throws for any non-Tauri caller that does not. That
shape is then validated, before dispatch, against a catalog that demands the
**local** shape:

| Artifact                                                                   | `git_clone` requires                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docs/api/mobile-companion-api.openapi.yaml` (public spec)                 | `remoteUrl`, `workspaceId`, `destinationRelativePath`, `adminLease` |
| `crates/cognia-cli/assets/host-command-catalog.json` (enforced at runtime) | `remoteUrl`, `destination`                                          |

Both declare `additionalProperties: false`, so the documented request fails
with `422 contract_input_violation` — 3 unexpected properties plus a missing
required one. `source_control.rs:57` _does_ rewrite `workspaceId` →
`destination`, but that runs inside `dispatch`, strictly after
`remote_execution.rs:264` validates. Validation is unconditional: the only
guard is the global `headless_contract_enforced()`, which defaults to on and
whose opt-out env var appears nowhere else in the repo.

**Root cause** — a deliberate five-line fork at
`scripts/build/gen-companion-api.mjs:2804`:

```js
for (const [name, schema] of inferredArgumentSchemas) {
  if (name.startsWith("git_")) {
    headlessArgumentSchemas.set(name, { source: "runtime-inferred", schema })
  }
}
```

The generator produces the remote shape via `rewriteRemoteGitRequestSchema`,
then this loop reverts `git_*` to the local shape — and _that_ map is what
builds `host-command-catalog.json`, the asset `include_bytes!`'d into the
desktop runtime to validate remote traffic. The intent is defensible
(`cognia-cli` runs locally and wants real paths); the defect is that one asset
serves two planes whose shape requirements are opposites.

**Why nothing caught it:** the fork is intentional, so no artifact comparison
flags it, and every existing `source_control` test calls `prepare_remote_args`
directly — bypassing `remote_execution::execute`, and therefore bypassing
validation entirely.

> Being handled as a **separate hotfix**, not as part of this audit's
> remediation. Direction: split the generator's output into a local-plane
> asset (for `cognia-cli`) and a remote-plane asset (for
> `command_manifest.rs`), making the fork explicit and gate-able. Do not delete
> the fork (breaks the CLI) and do not change the CLI's user-visible arguments.

#### 2. Reachable command + unreachable event stream = permanent silent no-op

`register_default_event_channels()` (`companion_api/commands.rs:498`) hardcodes
**18** forwardable channels. `register_tauri_event` installs no wildcard
listener, so an unlisted event cannot reach a remote client by construction.

Meanwhile these command families are fully allowlisted while their result
channel is dropped: `browser_*` (68) → `browser://*`; `connector*` (76) →
`connectors://*`; `plugin_python*` (34) → `plugin:python`; `codeserver*` (23) →
`codeserver://*`; `external_agent_*` → `external-agent://*`; `perf_*` (28) →
`perf://sample`. The caller receives HTTP 200 and then nothing, forever.

`ocr_download_model` / `ocr://download-progress` is the only streaming pair
that works end to end.

**Ungated on every axis:** `spec_parity.rs` contains zero occurrences of
"event"; `CommandDescriptor` has no streaming field; `companion-commands.json`
contains zero occurrences of `channel`. Adding an `app.emit` anywhere cannot
fail any test.

#### 3. Eight dispatch arms drop arguments

| Command                               | Dropped                         | Consequence                                                                                                           |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `claude_set_provider_env`             | `custom_headers`                | `ANTHROPIC_CUSTOM_HEADER_*` forwarding is unreachable remotely — this is the gate for 1M context via `anthropic-beta` |
| `claude_set_mode`                     | `command_id`                    | remote callers structurally cannot correlate the sidecar ack                                                          |
| `mcp_oauth_authenticate` / `_refresh` | `helper_path`                   | arm calls a different function (`headless_authenticate`)                                                              |
| `mcp_server_start` / `_restart`       | `sidecar_path`                  | host-chosen; may be intentional, but is unrecorded                                                                    |
| `plugin_load_vscode`                  | `sidecar_script`, `node_binary` | arm reads 3 of 5 params, calls `plugin_load_vscode_for_state`                                                         |
| `plugin_wasm_renderer_response`       | `response`                      | arm is unreachable anyway — see P2                                                                                    |

Because the hand-written schema encodes the truncation _and_ is enforced at
runtime, a client sending the fuller, correct payload gets `422` rather than a
graceful degrade. **Any fix must change the arm and the schema together.**

### Correction: the casing class — `git_*` was a symptom, not the disease

Fixing `git_*` exposed the general form. The RPC wire is snake_case by design
(`required_aliased`'s doc comment in `rpc.rs` says so), and the arms accept
camelCase as an alias so the headless brain's client works. **The request
schemas never learned about the alias.** They declared one spelling, under
`additionalProperties: false` — so a caller using the other spelling was
rejected before dispatch.

`CompanionTransport.call` does `JSON.stringify(args)` with no casing
conversion, so whatever `lib/**` passes is exactly what gets validated. And
`lib/claude/ipc.ts` passes camelCase. Net effect: **`claude_send` — the core
prompt path — returned 422 on every companion transport**, along with 88 other
commands.

Fixed systemically rather than by 89 hand-edits: `applyArgumentAliases` in
`gen-companion-api.mjs` now widens every generated schema to accept exactly
what its arm accepts, turning a required aliased field into an `anyOf` over the
two spellings. One rule, applied to every provenance (inferred, hand-written,
Zod).

Two further classes surfaced from the same root:

- **Deadlocked contracts (6).** The arm _required_ a field the schema _forbade_
  — send it → 422, omit it → 400, so the command was unreachable by any
  payload. `claude_approve` (the remote tool-approval path),
  `claude_plugin_tool_response`, `claude_tool_result_decision`,
  `claude_protocol_adapter_message` (`remote_execution_context`), and
  `plugin_python_call` / `plugin_python_module_call` (`generation`, declared in
  the JSON contract store but dropped by the Zod contract that overrides it).
  Now a gated check, `deadlocked-contract`.
- **Plane confusion.** `prepare_remote_args` legitimately accepts different
  shapes per plane, and the generator always knew — it builds the two specs
  from different schema maps. But only one catalog was emitted and the runtime
  validated both planes against it. Fixed by emitting
  `crates/cognia-headless-contract/assets/device-plane-overrides.json` (exactly
  63 `git_*` commands, matching this audit's independent count) and having
  `validate_contract_value` select by request scope.

### Correction: the event axis was mis-stated in both directions

§2 above says "18 forwardable channels" and derives "~77 of ~84 never reach a
remote client" from it. Building the fix showed that framing is wrong, and
wrong in a way that understated the problem.

`register_default_event_channels` governs only channels bridged from Tauri's
event system into the bus. It never governed channels published **straight into
the bus** from Rust, and there is a substantial set of those:
`a2ui://dispatch`, `agent://message`, `notification://remote`,
`host-state://action`, `perf://frame`, every `connectors://*` name, every
`external-agent://*` name, and every `gateway://*` name. Those reached every
connected device already, filtered by nothing but tenant and target-device id.

So the real state was not "18 allowed" but **"18 allowed, plus an unbounded set
that was never allowlisted at all"** — the same defect as the command plane,
where the curated `KNOWN_COMMANDS` list sat next to arms nobody had triaged.

Two consequences the original write-up missed:

- **`gateway://decide` carries `promptText`** — the user's prompt, verbatim
  (`crates/cognia-gateway/src/server.rs:1844`) — and the headless gateway host
  publishes it directly, so it reached every paired phone. It is now
  `ServiceOnly`. That is a privacy fix, not a regression, and it is called out
  here because it is the one place the widening made the stream _narrower_.
- Three channels had to be made `default_on` during the fix precisely because
  they were already reaching devices this way. Had the catalog been written
  from the registration list alone, `a2ui://dispatch`, `agent://message`, and
  `notification://remote` would have been classified opt-in and remote chat
  sessions would have gone dark. The gate's `uncatalogued-event-channel` check
  is what surfaced `notification://remote`.

The corrected shape of the finding: the event plane had **no allowlist, no
audience model, and no per-client subscription** — a channel either reached
everyone or nobody, decided by which of two publish mechanisms its emitter
happened to use.

### P1 — Function unavailable, but it reports an error

#### 4. 17 device-reachable arms are dead on the desktop, with a backwards message

These call `host.headless().ok_or_else(|| RpcError::headless_unsupported(name))`,
which emits _"requires the desktop app"_ — the exact opposite of the truth. They
are not in `SERVICE_ONLY_COMMANDS`, so a paired device can reach them on a
desktop-hosted companion server and receive a misleading 503:
`spawn_external_agent`, `send_to_external_agent`, `kill_external_agent`,
`get_external_agent_status`, `plugin_permission_{grant,list,revoke}`,
`plugin_api_{invoke,batch_invoke}`, `codeserver_{ensure,status,stop,stop_all}`,
`lsp_host_{ensure,request}`.

For contrast, exactly **one** arm is dead in the _headless_ direction
(`companion_endpoints`). The R5 migration succeeded; the reverse direction was
never checked.

#### 5. Four `Channel<T>` streaming commands have no RPC path

`terminal_spawn`, `ssh_terminal_spawn`, `terminal_reattach` are substituted by
a different protocol on `/ws/terminal` — documented at `rpc/terminal.rs:3`,
which satisfies the written-reason rule. `tts_realtime_synthesize` /
`tts_realtime_cancel` are covered by the ledger's `separate-design-required`
group (see below), so they are _recorded_ — but the reason is group-level, not
specific to the streaming problem.

### P2 — Contract drift and unfalsifiable claims

#### 6. 62 Tauri commands are triaged by nothing — and no gate catches that

Registered in `generate_handler!` but absent from `companion-commands.json`,
from the disposition ledger, and from `KNOWN_COMMANDS`. Examples:
`agent_session_api`, `browser_cdp_{execute,grant,revoke}`,
`cli_bridge_host_state_publish`, `close_tray_panel`,
`companion_create_worker_enrollment`, and the four new `dsh_runtime_*` commands
in the current working tree.

**Verified:** `pnpm audit:companion-command-manifest` **passes** with all 62
present. Its `compareCommandSets` checks descriptor → handler, never
registered-command → descriptor, so a Tauri command with no descriptor is
invisible to it. This is how 62 accumulated silently. (Contrary to an earlier
assumption, that gate does _not_ catch the new `dsh_runtime_*` commands.
`companion-api:check` is currently red, but on generated-artifact drift in
three committed files, which is a separate pre-existing condition.)

**Resolved.** All 59 remaining were read against their implementations and
given a descriptor plus a per-command written reason. The distribution is the
interesting part — the pile was not one thing:

| Disposition                | n   | Notes                                                                                                                |
| -------------------------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| `local-only`               | 45  | Tray popover windows, OS accessibility control, CDP against the embedded pane, FFmpeg on host paths, cursor position |
| `covered-by-headless`      | 5   | Worker administration (`fleet_worker_*`) and workflow approvals (`workflow_approval_*`), each cover named            |
| `runtime-internal`         | 3   | Post-commit broadcast receipts and the media response leg — not operator actions                                     |
| `separate-design-required` | 1   | `tts_proxy_cancel`, joining the fetch that mints its token                                                           |
| `unexposed-gap`            | 5   | **Genuine gaps** — see below                                                                                         |

Five commands take **no Tauri parameter at all**, resolve through process
globals documented as host-generic, and sit beside siblings already dispatched
remotely from those same globals. No property of the code explains their
absence, so they get a disposition that says exactly that rather than a
justification nobody could write:
`task_workspace_restore_snapshot` (every sibling in its mutation class is in
`rpc/filesystem.rs`), `fleet_opencode_outbox_status` and
`fleet_opencode_outbox_repair` (whose own doc comment calls it "a deliberate
operator action"), `agent_vendor_roots`, and `read_project_mcp_config`.

They are **recorded, not exposed.** Exposing them means widening the remote
attack surface — `outbox_repair` discards durable state and
`read_project_mcp_config` needs `authorize_workspace_root` gating on its `cwd`
or it becomes an arbitrary-path read — and that is a decision to take
deliberately, not as a side effect of an audit. Each entry names the sibling
whose dispatch pattern exposure would follow.

Two classification calls worth recording, because both could reasonably go the
other way:

- `terminal_take_control` / `terminal_release_control` **are** reachable
  remotely — `/ws/terminal` relays those frame kinds with no allowlist. They
  are still filed `local-only`, because `terminal_write`, `terminal_resize`,
  `terminal_spawn` and `terminal_set_flow_control` map to frame kinds the same
  socket relays and are all already `local-only`. One subsystem should not
  carry two conventions; the `/ws/terminal` fact lives in the reason text.
- `resolve_pi_extension` is answered by the headless CLI under the same command
  name, but in-process rather than through a route. That is host branching, not
  coverage, and its four `dsh_runtime_*` switch-siblings are filed the same way.

#### 7. `plugin_wasm_renderer_response` is a dead dispatch arm

Present in `rpc/plugins.rs`'s `COMMANDS` table but absent from
`KNOWN_COMMANDS`, so the gate at `rpc.rs:2608` rejects it before the submodule
chain runs. Exactly the drift the `KNOWN_COMMANDS` doc comment warns about. The
ledger classifies it `runtime-internal`, so the _exclusion_ is intentional —
the dead arm is not.

#### 8. Response validation is vacuous for 466 of 493 commands

> **Correction — the 466 was the gate's bug, not the repo's.** The real number
> is **325**, exactly what `isOpaqueSchema`'s own doc comment already claimed
> while its body counted something else. The predicate returned "opaque" for any
> schema with no top-level `properties` key, which put `{"type":"null"}` — the
> tightest schema expressible — in the same bucket as a union over every JSON
> type. 141 commands were misfiled that way: 118 `NullResult`, 11
> `BooleanResult`, 10 `StringResult`, plus `perf_open_lease` (a `oneOf`) and
> `perf_read_observations` (a typed array), both fully structured.
>
> The debt is now graded and each grade is ratcheted by count in
> `rpc-semantic-parity-baseline.json`:
>
> | Kind                              | Meaning                                                        | At audit | Now |
> | --------------------------------- | -------------------------------------------------------------- | -------: | --: |
> | `opaque-response-schema`          | matches any JSON — validation really is a no-op                |      175 | 158 |
> | `unconstrained-response-contents` | root type pinned, contents not (`LegacyRecord` / `LegacyList`) |      150 | 141 |
>
> Two consequences the original framing hid:
>
> 1. **Step 2 of the plan below was already done.** No dispatch arm that
>    provably returns only `Value::Null` is still untyped — the 118
>    `NullResult` entries cover them.
> 2. **`LegacyRecord` and `LegacyList` are not catch-alls, and two commands
>    contradicted theirs.** They pin the root type, so a command that returns
>    something else fails the enforced check on every success:
>    - `secret_store_get` / `keyring_secret_get` were `LegacyRecord`
>      (`{"type":"object"}`) while the arm returns `to_json(Option<String>)` —
>      a bare string, or null for an absent key. No remote or mobile client
>      could read a secret.
>    - `fleet_get_snapshot` was `LegacyList` (`{"type":"array"}`) while the arm
>      serializes `FleetSnapshot`, a struct. The Agent Fleet view could not
>      load. The contradiction was already written down three lines above the
>      arm, in `fleet_event_payload`'s "fleet snapshot must serialize as an
>      object" — nothing ever compared that to the declared schema.
>
> Both are fixed and pinned by tests in `remote_execution.rs`. This class cannot
> be found by reading arm text: it needs the return TYPE, which is why the
> per-command method below is the right one. The remaining 141 container-typed
> commands have not been checked for the same defect.

`outputSchema` is `LegacyResult`-shaped — `{"type": ["object","array","string",
"number","boolean","null"]}` — which matches any JSON. All 493 response schemas
are hand-written; only ~29 are genuinely structured.

**Still open, and deliberately so.** This is the one finding the remediation did
not touch, because the obvious fix is unsafe and the measurement says why.

Output validation is **enforced**, not advisory: `remote_execution.rs:293` and
`:362` run `validate_output` and turn a mismatch into an error response. So
tightening a schema that is currently vacuous converts every response that does
not match into a hard failure. A wrong guess does not degrade — it breaks a
working command.

The tempting shortcut is to derive schemas from the `#[tauri::command]` return
types, which this gate already parses. Measured against the 466:

| Return type of the Tauri command | n   |
| -------------------------------- | --- |
| `Result<(), _>`                  | 98  |
| `Result<String, _>`              | 18  |
| `Result<bool, _>`                | 15  |
| numeric                          | 4   |
| a struct, enum, or collection    | 331 |

Only 135 are primitives, where serde attributes cannot alter the wire shape.
But the Tauri return type is **not** what goes on the wire — the dispatch arm
is, and this audit's central lesson is that the two differ. Of the 98 commands
whose Tauri type is `()`, only **22** have an arm that provably returns
`Value::Null` and nothing else. `claude_send` is in the other 76: its Tauri
signature returns `()` while its arm returns a value. Deriving from the
signature would have made the core prompt path fail output validation.

So the safe path is narrow and per-command, not mechanical: start from the ~29
already-structured schemas and the 22 doubly-confirmed nulls, and type the rest
by reading each arm's actual return expression. It is real work, it is
independently valuable, and it is a separate ratchet — not something to bolt
onto an audit under time pressure.

#### 9. The disposition ledger's largest claim class is unfalsifiable

`headless-command-dispositions.json` carries **one `reason` per group**, not per
command — a single sentence covers all 510 `local-only` entries.

- **`covered-by-headless` (74)** — asserts the capability already exists via the
  headless control plane. Verifying this mechanically is impossible with the
  artifacts on hand: the manifest's `capability` field is the constant
  `client.local` for 572 of 593 client commands, so it cannot discriminate.
  By family: `scheduler_*` (18) is **supported** — `scheduled_task_*` (16
  allowlisted commands) covers it under a different name. `vector_*` (33),
  `subscription_*` (18) and `telemetry_*` (5) have **no** covering command in
  `KNOWN_COMMANDS` and **no** corresponding field in `HeadlessServices`
  (`src-tauri/src/headless/mod.rs:116`). Those 56 claims may well be true via
  config or env, but nothing in the repo says so.

  **Resolved.** Each family was checked individually, and the group turned out
  to be four different situations wearing one label. It is now 35 commands,
  every one carrying a per-command reason that names its cover, and
  `unsubstantiated-coverage-claim` is a **gated** finding so the shared sentence
  can never again stand in for a cover that was never found.

  | Family                 |   n | Outcome                                                                                                              |
  | ---------------------- | --: | -------------------------------------------------------------------------------------------------------------------- |
  | `scheduler_*` CRUD     |   8 | Kept. Covered by the allowlisted `scheduled_task_*` bridge commands (`rpc/data_sync.rs:78`), named per command.      |
  | `scheduler_*` OS-level |  10 | Kept, different reason: arming the host's own alarm daemon, elevation, capability probes. Nothing remote can answer. |
  | `telemetry_*`          |   5 | Kept. Genuinely "standard Headless configuration" — `OTEL_EXPORTER_OTLP_*`, read at `telemetry.rs:311-323`.          |
  | `vector_cloud_*`       |  12 | Kept. Proxies the operator's own cloud vector DB, which a headless install reaches directly.                         |
  | `vector_*` (native)    |  21 | → `local-only`. Operates on the desktop's on-disk sqlite-vec store; no `HeadlessServices` field, no RPC arm.         |
  | `subscription_*`       |  18 | → `local-only`. **The claim was backwards**, see below.                                                              |

  `subscription_*` is the one worth stating plainly. The ledger said the
  capability was already available through the headless plane. The source says
  the opposite, in a comment written at the point of exclusion
  (`rpc/chat.rs:286-292`): subscription account management "is deliberately
  **desktop-only**: it reads and writes the provider credential vault, so it is
  not exposed to remote/mobile clients." A ledger entry asserting remote
  availability for eighteen credential-vault commands is not a vague claim, it
  is the wrong one — and it survived because nothing ever compared the label to
  the reason sitting in the code beside it.

- **`local-only` (510)** — the group reason is "depends on renderer / local
  window / desktop state / hardware / OS-local gesture". That is plainly untrue
  for 20 of them, which are simultaneously in `KNOWN_COMMANDS`, including the
  core mobile data plane: `sync_pull`, `message_send`, `message_update`,
  `session_list`, `session_timeline`, `twin_profile_get`. The generator only
  requires a disposition to exist for `target: client` commands; it never
  compares against `KNOWN_COMMANDS`. These are "brain-owned and bridged", which
  is a coherent design — but `local-only` is the wrong label for it, and the
  ledger has no vocabulary for the distinction.
- **`separate-design-required` (8)** — all `tts_*`. Coherent and specific.

---

## What landed with this audit

`pnpm audit:rpc-semantic-parity` — a gate that parses the
`#[tauri::command]` signatures themselves, the artifact no generator in this
repo reads, and holds the RPC arms and enforced contract schemas to them.

- Gated kinds (hard failure): `missing-params`, `schema-missing-params`,
  `arm-not-allowlisted`, `known-command-without-arm`, `unregistered-command`.
- Report-only: `desktop-dead`, `channel-command-excluded`,
  `opaque-response-schema`, `unreferenced-catalog-entry`,
  `uncatalogued-event-channel`.
- 80 known findings recorded in `scripts/gates/rpc-semantic-parity-baseline.json`;
  the list may only shrink.
- Scope this phase: the ~392 commands with real Rust argument handling. The 101
  commands routed through the single bridge arm at `rpc/data_sync.rs:536` are
  skipped at the arm level (they forward the whole `args` blob, so they cannot
  truncate) but are still covered by the schema check.

Effectiveness verified by deleting `claude_set_provider_env:missing-params`
from the baseline: the gate fails and names `custom_headers`.

### The event checks, and what they deliberately do not claim

The two event-axis checks are report-only, and the liveness one is narrower
than it first looks. That is on purpose.

"Is this channel ever emitted" is **not statically decidable here**:
`git://status-changed` is emitted through a `const`, `claude://message-added`
is assembled as `` `claude://message-${kind}` ``, connector channels are minted
per adapter with `format!`, and roughly half the emitters are TypeScript while
the catalog is Rust. The first version of this check scanned emit-site literals
and reported 41 live channels as dead — worse than no check at all, because a
41-line false-positive list trains people to ignore it.

So the question was narrowed to one that is decidable: **does this name appear
anywhere outside the catalog?** A `false` is unambiguous — the constant behind
the entry was renamed, or it was a typo. It will not catch a channel that is
declared and listened for but never emitted (`companion://device-paired` is
exactly that). Nothing static can, so the catalog note says so in prose rather
than the gate pretending to know.

The other check, `uncatalogued-event-channel`, has to strip `#[cfg(test)]`
blocks before scanning; without that, five fixture channels
(`test://a`, `some://other`, …) show up as production gaps.

---

## Remediation plan

**P0**

1. `git_*` — split the generator into local-plane and remote-plane catalogs.
   _Separate hotfix, already scoped._
2. Event axis, **in this order**: add server-side per-channel subscription and
   capability filtering to `EventBus` _first_, then widen the 18-entry
   allowlist. Reversing the order amplifies a real problem — `ws.rs:180` and
   `signaling/dispatch.rs:160` currently fan every bus frame out to every
   connected device, filtered only client-side, so going 18 → 84 multiplies
   bandwidth and exposure ~5×.

   **Done, in that order.** `event_channels.rs` holds a 70-entry catalog; each
   entry declares an audience (`Any` / `ServiceOnly`), whether it is on by
   default, and whether Tauri forwarding applies. `EventSubscription` gates
   delivery on both the WebSocket (`ws.rs`) and WebRTC (`signaling/dispatch.rs`)
   paths, and clients widen or narrow with a `subscribe` control frame whose
   refusals come back **named** rather than dropped. The `default_on` set is
   pinned by a test to exactly what reached clients beforehand, so no deployed
   client changes behaviour without asking. An uncatalogued channel is not
   deliverable at all, which is what keeps `record:event` (keystrokes plus OCR
   of the screen) and `selection://stage` (selected text from any application)
   off the wire by construction rather than by nobody having added them yet.

3. The 8 argument truncations — fix the arm **and** the hand-written schema in
   the same change, or record a per-command written reason.

**P1** 4. Correct the `headless_unsupported` message direction; reclassify the 17
device-reachable arms. 5. Error axis, minimum viable: restore `retryable` to `RpcError` so the client
stops inferring it from the HTTP status, and pass through `code` for commands
already wrapped in `CommandError`. Typing all 368 `RpcError::internal` call
sites is a separate ratchet. 6. Add a parity check between `host-command-catalog.json` and
`companion-request-schemas.json` for remote-transport commands, with
deliberate plane forks **explicitly registered** rather than hidden in a
`startsWith("git_")` branch. 7. Add tests that exercise the full `remote_execution::execute` path including
`validate_contract_value` — at least one representative command per dispatch
submodule. Their absence is why P0-1 survived.

**P2** 8. Give the disposition ledger per-command reasons, and a label that separates
"brain-owned but remotely bridged" from "genuinely local-only". 9. Triage the 62 unclassified commands; register `dsh_runtime_*`. 10. Delete the dead `plugin_wasm_renderer_response` arm. 11. Model the TypeScript bridge side so the remaining 101 commands leave the
gate's exemption list.

---

## Notes on method

- Every number here is reproducible from the repo:
  `pnpm audit:rpc-semantic-parity:report`.
- The `git_*` verdict is a static trace (route → `execute` → unconditional
  `validate_contract_value` → `embedded()` → the printed asset), not a live
  request. `strict_contract_errors_are_typed_and_do_not_echo_values` in
  `remote_execution.rs` proves the 422 rejection semantics are live for a
  different command. A single runtime smoke against `/api/_rpc/git_status`
  would close the last gap.
- Cross-validation: the new gate reports zero `known-command-without-arm`, and
  the Rust test `every_known_command_has_a_dispatch_arm` passes. The two were
  written independently against the same invariant and agree. All three
  `spec_parity` tests pass as well.
- Pre-existing red gates and tests observed while running this audit, unrelated
  to it and left untouched (this audit added no Rust and no `protocol/*.json`
  changes):
  - `gates:registry` — 14 unregistered scripts, verified red at HEAD.
  - `check:sdk-surface` — Agent SDK version drift (0.3.220 vs 0.3.227).
  - `audit:colocated-tests` — 11 files in the current working tree.
  - `cargo test --lib companion_api` — 724 pass, **6 fail**, including
    `command_manifest::tests::embedded_headless_contract_matches_the_generated_inventory`
    and `shared_manifest_is_complete_and_validated`. These are the same
    generated-artifact drift that `companion-api:check` reports, and they mean
    the embedded catalog currently disagrees with what the generator would
    produce from the working tree. Worth clearing before the `git_*` hotfix, as
    that fix edits the very generator whose output is already drifted.

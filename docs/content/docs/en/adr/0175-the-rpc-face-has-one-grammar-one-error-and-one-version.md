---
title: "0175: The RPC face has one grammar, one error, and one version"
description: "Every companion command is named <resource>.<verb> over a declared resource tree and a closed verb vocabulary. Every failure is one RFC 9457 problem document. One contract version names what a client was compiled against. The allowlist stays the security perimeter and is generated from the contract instead of typed twice, and output schemas derive from the Rust types that produce them."
---

# ADR 0175: The RPC face has one grammar, one error, and one version

**Status:** Accepted
**Date:** 2026-09-09
**Amends:** ADR-0013 (command manifest), ADR-0171 (the CLI speaks the protocol)
**Related:** ADR-0059 (headless brain), ADR-0090 (canonical agent command names), ADR-0143 (device console tri-state), ADR-0153 (the host obtains the confirmation)

## Context

The companion RPC face is the one API every client of a Cognia host speaks: `POST /internal/_rpc/{name}` for the brain over the loopback service plane, and `POST /api/_rpc/{name}` for paired phones, browser extensions, and the CLI over DPoP. The generated specs today carry 673 concrete internal operations and 544 device-reachable ones, out of 1,328 descriptors in `protocol/companion-commands.json`.

It grew one command at a time, and nothing ever held the whole to a shape. An audit on 2026-09-09 found the following, all verified in code rather than inferred.

1. **No naming grammar.** The verb sits at the front (`get_close_behavior`), at the back (`automation_settings_get`), or nowhere (`browser_pages`). One board lives under two prefixes (`agent_task_*` and `team_task_*`). Singular and plural prefixes coexist for one subsystem (`skill_` and `skills_`, `connector_` and `connectors_`). Four words mean stop (`_stop` 20 times, `_cancel` 11, `_abort` 9, `kill` 4). `status` appears 44 times and `state` 8 times with no rule between them. The CLI index derives `group` and `action` by splitting on the first underscore, so `agent_task_cancel` is filed under `agent` with the action `task-cancel`.
2. **At least seven error envelopes.** `api.rs` serialises `{error: {code, message, requestId, retryable, details}}` and calls it canonical. `middleware.rs` serialises a flat `{code, message, requestId}` and calls it unified. `rpc.rs` carries `RpcError {code, message, retryable}` with no request id. The Lark entry answers `{error: "x"}` in one place and `{status: "error", error: "x"}` in another. Draining answers plain text. Receipts persist `{httpStatus, error}`. One code, `MEDIA_NOT_FOUND`, is upper case.
3. **Four pagination vocabularies.** `limit` on 17 commands, `offset` on 10 (where it also means a byte offset in the `*_chunk` family), `cursor` on 6, `before` on 1. `session_list` takes `limit` and `offset` together.
4. **Two parameter casings on one wire.** Arms accept both `session_id` and `sessionId`, the CLI index prints "Also accepted as" for every such field, and the bridge fixture documents that sync payloads are snake_case while message payloads are camelCase.
5. **Five version counters.** `HEADLESS_CONTRACT_VERSION` is 1 (the host catalog's schema version), the manifest says `schemaVersion: 2`, the bridge frame protocol is 3, the Agent SDK RPC protocol is 2, and every other `protocol/*.json` says 1. The `contractVersion` a brain sends in its `hello` does not name the document that defines the commands it will call.
6. **No runtime discovery.** A phone ships all 1,328 descriptors as a build artifact to learn what it may call. There is no endpoint that answers "which commands may this principal invoke on this host".
7. **Hand-written output contracts.** `protocol/companion-response-schemas.json` holds 661 output schemas typed by hand, and no Rust type derives them. A root-type mismatch (`integration_ingress_poll` returns a list, the schema said object) turned every `cognia-agent serve` boot into a `500 contract_output_violation` on Marketplace ingress before it was caught.
8. **75 request schemas are inferred from Rust match arms** by the generator, `cli:api:check` was not in `check-all` although ADR-0171 says the CLI stays correct by gate, and the docs said 450 commands, bridge v2, and `Authorization: DPoP` where the code has 661, v3, and `Authorization: Bearer` plus a `DPoP` header.

ADR-0013 chose a hand-written allowlist over codegen when the surface was about 40 commands and wrote that the decision should be revisited past roughly 150. ADR-0171 invoked that clause for the client side and generated the CLI index from the contract. The host side was never revisited.

## Decision

The industry references this follows are Google's API Improvement Proposals (AIP-121 resource orientation, AIP-131 to 136 standard and custom methods, AIP-151 long-running operations, AIP-158 pagination), RFC 9457 problem details, Connect-RPC's one-path-per-method with one error shape, and the discovery endpoints of Kubernetes and MCP. None of them is adopted wholesale. Each one answers one of the eight findings.

### 1. One grammar

A wire name is `<resource>[.<sub>...].<verb>`. Segments are lower snake_case. The verb is always the last segment.

- `resource` is a path in `protocol/companion-resources.json`. Nouns are singular (`session.message`, `team.task`, `git.branch`).
- `verb` is one entry of `protocol/companion-verbs.json`, optionally followed by a qualifier that stays on the verb (`set_bounds` is spelled `bounds.set`, but `read_chunk`, `list_pending`, `navigate_back` and `install_from_github` keep their qualifier because it is adverbial, not a noun). Every verb carries a one-line definition. Standard verbs are `list`, `get`, `create`, `update`, `delete`.
- Refused verbs name their replacement: `kill` and `terminate` are `stop` with `force: true`, `abort` is `cancel` except under `git` where it is the domain word, `destroy` and `remove` are `delete`, `state` is `get`, `execute` is `exec`, `check` and `test` are `probe`.
- One word per meaning. `cancel` ends a terminating lifecycle (task, run, job, upload, operation, handoff). `stop` halts a restartable process or service. `interrupt` stops the current turn while the session survives. `status` reads a lifecycle or health summary and `state` is never a verb. `probe` answers a yes-or-no question without side effects.

Worked examples of what the grammar does to the worst cases:

| Before | After |
| --- | --- |
| `get_close_behavior`, `automation_settings_get` | `app.close_behavior.get`, `automation.settings.get` |
| `agent_task_cancel`, `team_task_move` | `team.task.cancel`, `team.task.move` |
| `agent_send`, `claude_send` (ADR-0090 alias) | `agent.session.send` (one command) |
| `kill_external_agent`, `background_job_kill` | `external_agent.stop`, `background.job.stop` |
| `browser_pages`, `browser_new_page` | `browser.page.list`, `browser.page.create` |
| `list_external_agents` (desktop process list), `external_agent_list` (brain roster) | `external_agent.process.list`, `external_agent.list` |
| `session_list {limit, offset}` | `session.list {pageSize, pageToken}` |
| `scheduler_create_task` (OS scheduler), `scheduled_task_create` (host scheduler) | `scheduler.system_task.create`, `scheduler.task.create` |

`protocol/companion-command-renames.json` records every old name, its canonical name, and, where two old names were one operation, which one survives (`merge`).

### 2. One contract, one version

`protocol/companion-commands.json` is the command contract at `contractVersion: 3`. Each descriptor now declares `resource`, `verb`, `arm` (the Rust dispatch literal), `pagination` (`none`, `page-token`, `byte-range`), and `longRunning`, next to the policy fields ADR-0013 introduced.

`CONTRACT_VERSION` lives once, in that file. `contract-identity.ts`, the generated Rust table, the CLI index, the OpenAPI `info.version`, and the `hello` frame are generated from it or asserted equal to it. It bumps when a client compiled against the previous contract could send something the host now refuses or mis-parse something it now returns: a command removed or renamed, a required input added, an input field removed, an output root type changed, or the `Problem`, `Operation`, or `Page` shapes changed. A new command or a new optional field only moves `catalogHash`.

`BRIDGE_PROTOCOL_VERSION` stays a separate number. It versions the frame grammar of the brain bridge (`hello`, `event`, `respond`, `worker_attach`), which can change with zero command changes and vice versa. The `hello` carries both.

The same-repo brain bridge keeps refusing on an exact `catalogHash` mismatch. Paired devices refuse on `contractVersion` only. A phone in an app store cannot ship in lockstep with a desktop auto-update, and refusing on the hash would turn "the host added an optional field" into "the phone cannot pair". Skew inside one contract version is answered per command by 404 and 410 and by the catalog endpoint below.

### 3. One error

Every failure on every plane is one RFC 9457 problem document with `Content-Type: application/problem+json`:

```json
{
  "type": "https://cognia.dev/problems/command_renamed",
  "title": "Command renamed",
  "status": 410,
  "detail": "session_list is now session.list",
  "instance": "/api/_rpc/session_list",
  "code": "command_renamed",
  "requestId": "…",
  "retryable": false,
  "details": { "replacement": "session.list" }
}
```

`code` stays a snake_case string. `requestId` equals the `x-request-id` response header. `retryable` says whether repeating the identical request can succeed. `operationId` is present when the failure belongs to a long-running operation. The type lives in a leaf crate, `cognia-problem`, because `cognia-gateway`, `cognia-connectors` and `cognia-headless-contract` do not depend on `cognia-core`. `ExecutionError` already carries exactly these fields and becomes `Problem`. `RpcError` stays an arm-internal type that converts to `Problem` at the plane boundary. Frames on the WebSocket, WebRTC and bridge planes keep their envelope and carry a `Problem` as their error member. Lark's own webhook acknowledgement format is a foreign protocol and stays.

### 4. One pagination and one operation shape

`list` verbs take `pageSize` and `pageToken` and return `{items, nextPageToken}` (AIP-158). `offset` and `length` are reserved for byte I/O on `read` and `write` verbs and are refused everywhere else. `limit`, `cursor`, `before`, and `page` are not parameter names on this surface.

A page token is opaque to the caller. Underneath it is a base64url `o:<offset>` for the offset-paged stores and `c:<cursor>` for the sequence-paged ones, so a client can never hand one plane the other plane's cursor. `pageSize` is optional and bounded (default 50, at most 1000). A `list` whose whole answer is bounded today takes no paging parameters yet and keeps answering the whole set. The gate reports those until their arms migrate, and fails any command that names `limit`, `offset`, `cursor` or `before` while claiming page tokens.

A `longRunning` command returns `Operation {id, done, error?, result?, metadata}` with `202 Accepted`, and `GET /api/operations/{id}` and `GET /internal/operations/{id}` return the same shape. Run, job, batch and delivery families normalise their verbs to `start`, `cancel`, `get`, and `list`.

### 5. Discovery

`GET /api/catalog` answers with `{contractVersion, catalogHash, commands}` filtered to what the calling principal may invoke, through the same admission predicate the dispatcher applies, so the catalog can never advertise what dispatch refuses. `GET /internal/catalog` answers with everything. `ETag` is the catalog hash. `GET /api/whoami` gains `contractVersion`, `catalogHash`, and `catalogUrl`.

### 6. What changes in ADR-0013

The allowlist is still the security perimeter and is still reviewed line by line. It is no longer typed twice. `src-tauri/src/companion_api/generated/known_commands.rs` is generated from the contract and carries the wire name, the arm, the resource and verb, the policy fields, and the rename table. `KNOWN_COMMANDS` in `rpc.rs` goes away. `rpc_handler` and `dispatch` resolve a wire name to its arm once and pass the arm to the existing `match` arms, so the 516 arms do not move on the day the names change. ADR-0013's "reconsider codegen past roughly 150 commands" clause is what this invokes. The surface is 1,328.

Output schemas derive from the Rust types that produce them. `schemars` `JsonSchema` derives on every wire type, a registry names the type each arm returns, and a `companion-contract-emit` binary writes `protocol/companion-response-schemas.json`. A hand-written root type can no longer disagree with the arm. Genuinely shapeless payloads (a raw PTY frame buffer) stay opaque with a stated reason and an owner, and the exact set is pinned by a test.

Request schemas come only from the contract catalog or the Zod contracts. `runtime-inferred` becomes a hard generator failure.

### 7. What changes in ADR-0171

The two authority modes are unchanged. The CLI index takes `group` and `action` from the declared `resource` and `verb` instead of splitting the name, so `cognia-agent team task cancel` is right by construction. `cli:api:check` joins `check-all`. Parameter aliases ("also accepted as") disappear with the casing rule: every input field is camelCase on both planes.

### 8. The hard cut

Old names are refused, not aliased. The host answers an old name with `410 command_renamed` and `details.replacement`. A codemod rewrites the 1,174 literal call sites found in `lib/`, `components/`, `app/`, `cli/`, `packages/`, and `plugins/`, and `check-command-grammar` refuses any surviving literal with an escape comment `// command-rename-exempt: <reason>` for dynamic dispatchers. The mobile shell, the browser extension, and the CLI live in this repository and change in the same commit set.

## Rollout

The work lands in six batches, each independently committable and gate-green.

| Batch | Lands | Gate that pins it |
| --- | --- | --- |
| B0 | This ADR, contract v3 files, `check-command-grammar` (rules R2, R6, R8 enforcing, R1, R3 to R5, R7 reporting until their batch), `cli:api:check` in `check-all`, the four documentation corrections | `audit:command-grammar`, `audit:companion-command-manifest` |
| B1 | `crates/cognia-problem` and the single error envelope | `problem_surface.rs`: every error response is `application/problem+json` |
| B2 | Generated `known_commands.rs`, `/api/catalog`, `/internal/catalog`, `contract-identity.ts` | `generated_table_matches_protocol_contract`, `device_catalog_equals_what_dispatch_admits` |
| B3 | `Page`, `PageRequest`, `Operation` helpers, the ten arms that page today, and the `Operation` document on 202 and both operation routes | R4 fails a legacy paging name on a page-token command, `companion-paging.test.ts`, `bridged_paging_translates_the_wire_shape_and_wraps_the_legacy_answer` |
| B4 | `schemars` derives on every arm output, the emitter, the 75 missing request contracts | `registry_covers_every_dispatchable_arm`, `emitted_catalog_matches_committed` |
| B5 | The rename cut: names become dotted, `CONTRACT_VERSION` 3 is live, codemod, docs | R1 and R7 flip to enforcing, `companion-api:check` |

The rest of the `protocol/*.json` files still carry `schemaVersion: 1` as a file-format marker. Each is retired into `contractVersion` by the batch that regenerates it.

## Consequences

- A reader who knows one command knows how every other one is spelled. A new command that breaks the grammar fails `pnpm audit:command-grammar` before it fails a reviewer.
- A client parses one error type. `requestId` is on every failure, and `retryable` is stated by the host rather than guessed from the HTTP status.
- `transport.call` becomes typed: `call("session.list", {pageSize: 20})` knows its input and its output from the generated `lib/tauri/generated/commands.ts`.
- A stale device learns it is stale from `contractVersion` and can show the tri-state ADR-0143 asks for, instead of collecting 403s one command at a time.
- The labour is real. About 95 production `json!(…)` arms need a struct, 75 request contracts need writing, and 1,174 literals need the codemod. The opaque count, the inferred-schema count, and the literal count are each pinned so they can only fall.
- Two decisions that read as exceptions are deliberate. `status` is allowed without a lifecycle because it is the one word for "health summary" and `state` is refused, so the arbitrary split is gone even where no `start`/`stop` exists. `fetch` is allowed for retrieval from a remote origin because `get` means "read a local record" and the distinction is load-bearing for `ocr.http.fetch` and `connector.attachment.fetch`.

## Out of scope

The Dify `/v1/*` compatibility profile and the gateway `/v1/*` profile are foreign protocols and keep their shapes. The event-channel catalog settled by the 2026-08-15 audit keeps `scheme://path` identifiers, and aligning them to `resource.event` is a future ADR. The Agent SDK RPC, ACP and A2A envelopes are their own protocols. The bridge frame grammar stays at protocol 3. The seventeen mounted `/connectors` and `/integrations/lark` routes are already tracked as a documentation follow-up in `docs/api/README.md`. Device routes stay unversioned.

## Alternatives considered

- **Keep snake_case and only enforce verb position.** Rejected. The rename happens either way, and a flat name hides the resource boundary that `team.task.cancel` makes visible.
- **Refuse devices on an exact catalog hash.** Rejected on the app-store argument above. The brain bridge keeps it because it deploys in lockstep.
- **Keep hand-written output schemas and add a fixture test.** Rejected. The `integration_ingress_poll` incident was a fixture that agreed with the schema and disagreed with the arm.
- **JSON-RPC 2.0 batch over one `/rpc` path.** Rejected. One path per command keeps DPoP `htu` binding per command, one idempotency key per request, and one OpenAPI operation per command, which is what the generated specs, the CLI index, and the parity gates are built on.
- **Aliases for a release.** Rejected by the user. Every client is in this repository, and `410` with a replacement is refusal that a phone log can act on.

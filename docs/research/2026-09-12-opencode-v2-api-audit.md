# OpenCode V2 current API audit

Date: 2026-09-12  
Scope: current native V2 control contract, compared with Cognia's previous pinned preview adapter.  
Evidence: published `@opencode/client@2.0.0` package, `@opencode/cli` latest tag (`2.0.0`), and current official V2 documentation. This is a contract audit; it does not claim that every endpoint has been exercised against a live server.

This dated audit supersedes the protocol/version recommendations in [the 2026-08-23 baseline](opencode-official-support-baseline-2026-08-23.md). That report remains historical evidence. A separate file preserves its dated findings without rewriting history.

## Implemented and verified in Cognia

The runnable native route is now `opencode-v2-service` / `opencode-v2`. The manager no longer registers the retired `opencode` V1 execution adapter, and the old native presets are not launch options. OpenCode ACP remains selectable and points to the current CLI. Saved identifiers and historical import code are retained; they do not activate a protocol fallback.

The current adapter implements local discovery and explicit remote endpoints with native Basic authentication, native health/version validation, session create/list/resume/fork/delete, paged history, model/variant selection, permission policies and responses, native commands, instructions, compaction, steering, attachment transport, and execution events. Resuming a session restores pending permission requests and forms into the shared UI; successful replies advance the queue, while failed replies remain available for retry. `getOpenCodeV2Adapter().getSdkClient()` exposes the typed current native API, with the same platform streaming transport and PII checks, including decoded text data URIs. This native API exposure is not a claim that every API has a dedicated Cognia UI.

The checked-in [real CLI smoke](../../scripts/smoke/opencode-v2-smoke.ts) passes 15 categories against the globally installed `opencode v2.0.0`. It uses a real isolated OpenCode service and a deterministic localhost model endpoint: text, reasoning, instructions, native command invocation, actual shell execution, approval/rejection, and cancellation all cross the real CLI/API boundary. No external paid model or user credential is used. The service, model fixture, created sessions, and temporary XDG state are cleaned up. Reproduce from the repository root:

```sh
rtk node --import tsx scripts/smoke/opencode-v2-smoke.ts opencode --adapter
```

The 105 focused adapter tests pass with 99.78% line coverage, 95.45% branch coverage, and 100% function coverage. The 18 event/history tests pass with 100% line/function coverage and 95.94% branch coverage; the combined final adapter/event run passes all 123 tests. All 45 external-agent hook tests pass. The focused lint checks pass. The repository-wide coverage attempt is not passing: the first shard encountered `components/shell/workspace-manage-dialog.test.tsx` failing to find the `openFolder` button and later exhausted its worker heap. A whole-project TypeScript run also reports unrelated existing errors; these are separate from the scoped OpenCode checks.

The settings suite passed 48 tests after adding native Basic authentication and credential-clearing behavior. Browser checks confirmed the V2 form and invalid-endpoint rejection; the new Basic fields also rendered. A later concurrent DSH edit blocked the final browser save/edit/clear flow (missing `DshSdkClientAdapter` export) and a settings rerun (the `dsh-sdk.mcp` capability lacked a required `reasonKey`). The final 21-file scoped TypeScript check reports two diagnostics in the shared manager from that DSH export mismatch and its lost callback typing; no other scoped file reports a diagnostic. Those later shared-tree checks are not reported as passing.

Known interface boundaries remain explicit:

- Native MCP control is location-scoped, not session-private. Per-session `mcpServers` and additional workspace roots are rejected instead of silently discarded or changing shared workspace configuration.
- Native conditional forms, mixed external-link/forms, and custom multiselect forms are available through the SDK but are not representable in the shared Cognia form renderer. The chat adapter cancels them and reports an explicit error rather than leaving the execution blocked. Ordinary typed forms retain and validate numeric/string/array constraints.
- A remote or locally discovered service is owned by its operator. Disconnecting Cognia interrupts its active executions and closes subscriptions; it does not terminate the shared service.
- The WebSocket PTY upgrades require their native transport; exposing their HTTP token methods does not implement an interactive terminal UI.

## Current contract and coverage boundary

The current browser client is `OpenCode.make` from `@opencode/client`, with native HTTP requests below `/api/` and SSE subscriptions at `/api/event`. The installed CLI package is `@opencode/cli`; its executable remains `opencode`. The former `@opencode-ai/sdk/v2/client` preview API is not the current native V2 contract. Sources: [client documentation](https://opencode.ai/v2/docs/build/client/), [installation](https://opencode.ai/v2/docs/), and [published client package](https://registry.npmjs.org/@opencode/client/2.0.0).

The published [OpenAPI document](https://opencode.ai/v2/openapi.json) contains **139 HTTP operations**. The published client's generated Promise implementation contains **138 request/SSE descriptors**. These counts differ deliberately:

- Two documented routes upgrade to WebSockets: ordinary and persistent PTY connection. Their token-creation routes are present in the Promise client; the upgrade routes are not Promise methods.
- The client additionally implements `permission.rules`, a `PUT /api/session/{sessionID}/permission/rules` operation absent from the downloaded OpenAPI document.
- Thus the combined observed surface contains 140 distinct routes. Operation counts do not establish Cognia UI coverage or live conformance.

The native SDK exposes current migration-status metadata, but a latest-only Cognia adapter does not need to implement V1 execution, V1 endpoint fallback, or preview event translation. Client version and service version must be checked deliberately; an exact tested release is the most reviewable baseline while these native routes are still documented as experimental.

## Changes required from the pinned preview adapter

| Concern          | Previous adapter assumption                          | Current contract / required behavior                                                                                              |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Client import    | `@opencode-ai/sdk/v2/client`, `createOpencodeClient` | `@opencode/client`, `OpenCode.make`                                                                                               |
| Method namespace | `client.v2.session.*`                                | `client.session.*`; form and permission are top-level groups                                                                      |
| Responses        | `{data,error,response}` wrapper everywhere           | Methods reject on error; session create/get return `SessionInfo` directly; catalogs retain their documented location/data wrapper |
| Prompt           | `{prompt:{text,files}}`                              | Flat `{sessionID,text,files?,agents?,skills?,metadata?,delivery?,resume?,id?}`                                                    |
| Events           | `session.events`, `session.next.*`                   | Shared global `event.subscribe`; `session.*`; filter every event by its session                                                   |
| Admission race   | Construct stream, then prompt                        | Consume the lazy stream and observe `server.connected` before admitting the prompt                                                |
| Completion       | Infer success from step end / stream end             | Use execution outcome events and authoritative session state; stream closure alone is not success                                 |
| Tool identity    | `callID` and `tool` on tool-called event             | `data.id`; name first appears in `session.tool.input.started` as `data.name`                                                      |
| Timestamp        | `data.timestamp`                                     | Event envelope `created`                                                                                                          |
| Permission       | `permission.v2.asked`, nested session reply          | `permission.asked`; `permission.reply({sessionID,requestID,reply,message?})`                                                      |
| Questions        | Old question-shaped payload                          | `form.created` with `data.form`; typed form fields and keyed answers                                                              |
| History          | Empty messages on resume                             | `message.list`, cursor pagination, projected user/assistant/system/compaction message types                                       |
| Models           | First catalog model assumed default                  | Prefer session `model` and `model.default`; provider/model ids and model-owned variants                                           |
| Commands         | Sending slash text as an ordinary prompt             | `session.command({sessionID,command,text,files?,delivery?})` for catalog commands                                                 |
| Undo             | Only an advertised slash command                     | Native `session.revert.stage/clear/commit`; staging selects a message boundary and optionally files                               |
| MCP              | Blanket unsupported                                  | Native location-scoped catalog, add/remove/connect/disconnect/resource catalog                                                    |

All rows above describe findings and acceptance criteria, not a claim that the corresponding Cognia change has passed its tests.

## Execution lifecycle

`event.subscribe()` is lazy and live-only. Calling it or obtaining an iterator does not establish a network subscription; the first `next()` does. Wait for the `server.connected` marker before sending a prompt. Events from other sessions and locations must be ignored by the session consumer. Each subscriber has local cancellation, and the last subscriber leaving closes the common source. Source failure ends subscribers; they must resubscribe deliberately. See [client event contract](https://opencode.ai/v2/docs/build/client/).

The turn boundary is `session.execution.started` followed by one of `session.execution.succeeded`, `.failed`, or `.interrupted`. A tool loop may emit several `session.step.ended` events before the execution finishes. Step `finish` values include `tool-calls`, so that event must not itself produce a successful terminal result. Accumulate token totals across distinct assistant steps and avoid double-counting a replayed step. Use the latest session outcome and tokens when reconciling after transport loss.

The text/reasoning events identify `assistantMessageID` and `ordinal`. Tool input begins with `{id,name}`, then streams deltas; called/success/failed events retain `id`. The called event holds parsed input, and success holds structured `content`. Preserve result content instead of coercing objects to `[object Object]`. `SessionStructuredError` holds `type`, `message`, and optional `status`.

`session.wait({sessionID})` resolves when session work has finished, but a resolved wait alone does not encode a successful model outcome. `session.interrupt` returns `{interrupted:boolean}`. Cancellation must abort local iteration, interrupt provider execution, and settle the caller even if no more SSE data arrives. `session.log({sessionID,after?,follow?})` provides an experimental durable stream with sequence numbers and `log.synced`; it does not replace the live text-delta stream.

## Permissions, modes, forms, and models

Permission replies are `once`, `always`, and `reject`. Current rules use `{action,resource,effect}` with `allow`, `deny`, or `ask`; matching is ordered. Native action names include `shell`, `subagent`, and `edit`. OpenCode agent selection and permission policies are separate controls. A mode picker should use actual primary agents from `agent.list` and `session.switchAgent`, and permission-mode labels should only be advertised if they write a real policy. Source: [permissions](https://opencode.ai/v2/docs/permissions/).

The published SDK's `permission.rules` accepts a complete `permissions` array for a session. Keep this SDK-versus-OpenAPI discrepancy visible and include a live route check before relying on it. Session resume must also retrieve pending permission requests; live-only events cannot replay an already pending approval.

Forms carry `id`, `sessionID`, `title`, and nonempty fields. Fields can be string, number, integer, boolean, multiselect, or external. String and multiselect fields can declare options, custom answers, and bounds; fields may be conditional. Reply is `form.reply({sessionID,formID,answer:{[fieldKey]:value}})`, with string, number, boolean, or string-array values. Cancellation is `form.cancel`. A string-only question abstraction cannot claim full native form coverage without preserving types, constraints, conditional visibility, and external actions. Pending forms are recoverable through `form.list`/`form.state`.

Models belong to a location catalog. Session creation accepts an agent and model reference; selection uses `session.switchModel({sessionID,model:{providerID,id,variant?}})`. Preserve model ids containing additional `/` characters by splitting only at the first slash. Variants belong to their declaring model, so clear or validate a variant on model switch. Compaction uses `session.compact` and the normal wait/outcome handling.

MCP operations are location-scoped, not intrinsically private to a Cognia session. Local config uses `command:string[]`, optional `cwd` and `environment`; remote config uses `url`, headers, and optional OAuth configuration. Do not imply that changing location MCP config affects only one session.

## Transport and local service

The main client has no Node process dependency and accepts `fetch`. Its transport calls `fetch(URL, RequestInit)` and reads standard `Response` streams via `body.getReader()`. A desktop/native HTTP implementation must preserve streamed response bodies, cancellation, headers, status, and content type. Standard SSE content type is required. Inject Cognia's existing runtime-aware fetch where direct webview networking cannot reach/authenticate to the local service.

Node-side local service management is exported separately from `@opencode/client/service`. `Service.discover` finds a healthy registered instance without starting it; `Service.ensure` may start a process, and `Service.headers` builds authentication headers. Registration defaults to `$XDG_STATE_HOME/opencode/service.json` or `~/.local/state/opencode/service.json`. The discovery implementation probes `/api/health` and compares PID/version with registration. The endpoint can carry Basic authentication as username `opencode` and the registered password. Never print or persist that credential in audit output.

Service discovery returns endpoint URL/auth rather than a service-version property; call health on that endpoint to obtain `{healthy:true,version,pid}`. Keep process management in Cognia's sidecar, outside the static-export frontend. A stopped or incompatible service should produce a specific actionable failure. Sources: [local service API](https://opencode.ai/v2/docs/build/client/), [published service implementation](https://registry.npmjs.org/@opencode/client/2.0.0).

## Real smoke acceptance

1. Verify `opencode --version` and the exact installed `@opencode/client` version. Start an isolated service with the current CLI and a temporary test directory; avoid replacing a user's registered service.
2. Check `/api/health`, session/catalog reads, create/get/list pagination, agent/model/variant selection, pending permissions/forms, and native compaction/revert routes. Distinguish unsupported route errors from authentication and transport failures.
3. Subscribe before prompt admission. Send a harmless prompt, observe streamed text, and verify exactly one terminal event with the actual execution outcome. Repeat with a resumed session and inspect history.
4. Trigger a safe tool call, a permission request, and a typed form. Confirm replies unblock the same execution; test rejection and form cancellation.
5. Interrupt during streaming, during a tool, and while awaiting approval. Confirm provider work and local iteration settle. Disconnect the event source and ensure it cannot silently report success or hang forever.
6. Exercise attachment handling and the outbound PII gate through the real Cognia call path. A fake provider can validate real HTTP and SSE transport without spending on a model; report it separately from a real model invocation.
7. Delete only sessions and processes created by the smoke. Report protocol transport, provider invocation, browser/Tauri UI, and broad coverage as separate evidence.

CLI commands support dedicated servers and standalone execution; `opencode serve --cors <origin>` configures a browser origin. Reference: [current CLI commands](https://opencode.ai/v2/docs/cli/commands/).

## Current shared form renderer limitations

The V2 event projection uses Cognia's existing ACP elicitation renderer for scalar fields, fixed multiselect choices, and a single external URL. Conditional fields, custom-entry multiselect fields, and forms mixing external URLs with other fields cannot currently be represented by that renderer. The mapper emits explicit `opencode_form_*` errors and retains the original `FormInfo`; the adapter must cancel such native requests so execution does not wait forever. These are renderer limitations, not absent native APIs: `client.form.*` remains available through the current SDK.

Step usage is deduplicated by assistant message and summed across tool loops. Completion tokens include both output and reasoning tokens; reasoning is also preserved separately. The current V2 contract calls step cost `MoneyUSD`, so this V2 mapper can label the reported total as USD. This does not change the currency policy of the older, separately implemented native adapter.

## Complete published HTTP operation inventory

Generated from the official OpenAPI downloaded on 2026-09-12. Operation IDs retain upstream naming, which is not always identical to the Promise client nesting (for example, `session.form` becomes top-level `form`, and `fs` becomes `file`). These are upstream endpoints, not assertions that Cognia surfaces all of them.

| Method | Path                                                                  | Upstream operation ID                            |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/health`                                                         | `v2.health.get`                                  |
| GET    | `/api/server`                                                         | `v2.server.get`                                  |
| GET    | `/api/location`                                                       | `v2.location.get`                                |
| GET    | `/api/agent`                                                          | `v2.agent.list`                                  |
| GET    | `/api/agent/{agentID}`                                                | `v2.agent.get`                                   |
| GET    | `/api/plugin`                                                         | `v2.plugin.list`                                 |
| POST   | `/api/plugin/await-activation`                                        | `v2.plugin.awaitActivation`                      |
| POST   | `/api/plugin/check`                                                   | `v2.plugin.check`                                |
| POST   | `/api/plugin/update`                                                  | `v2.plugin.update`                               |
| GET    | `/api/session`                                                        | `v2.session.list`                                |
| POST   | `/api/session`                                                        | `v2.session.create`                              |
| GET    | `/api/session/stats`                                                  | `v2.session.stats`                               |
| POST   | `/api/session/import`                                                 | `v2.session.import`                              |
| GET    | `/api/session/{sessionID}/export`                                     | `v2.session.export`                              |
| GET    | `/api/session/active`                                                 | `v2.session.active`                              |
| GET    | `/api/session/{sessionID}`                                            | `v2.session.get`                                 |
| DELETE | `/api/session/{sessionID}`                                            | `v2.session.remove`                              |
| POST   | `/api/session/{sessionID}/fork`                                       | `v2.session.fork`                                |
| POST   | `/api/session/{sessionID}/agent`                                      | `v2.session.switchAgent`                         |
| POST   | `/api/session/{sessionID}/model`                                      | `v2.session.switchModel`                         |
| POST   | `/api/session/{sessionID}/rename`                                     | `v2.session.rename`                              |
| POST   | `/api/session/{sessionID}/move`                                       | `v2.session.move`                                |
| POST   | `/api/session/{sessionID}/prompt`                                     | `v2.session.prompt`                              |
| POST   | `/api/session/{sessionID}/command`                                    | `v2.session.command`                             |
| POST   | `/api/session/{sessionID}/skill`                                      | `v2.session.skill`                               |
| POST   | `/api/session/{sessionID}/synthetic`                                  | `v2.session.synthetic`                           |
| POST   | `/api/session/{sessionID}/shell`                                      | `v2.session.shell`                               |
| POST   | `/api/session/{sessionID}/compact`                                    | `v2.session.compact`                             |
| POST   | `/api/session/{sessionID}/wait`                                       | `v2.session.wait`                                |
| POST   | `/api/session/{sessionID}/revert/stage`                               | `v2.session.revert.stage`                        |
| POST   | `/api/session/{sessionID}/revert/clear`                               | `v2.session.revert.clear`                        |
| POST   | `/api/session/{sessionID}/revert/commit`                              | `v2.session.revert.commit`                       |
| GET    | `/api/session/{sessionID}/context`                                    | `v2.session.context`                             |
| GET    | `/api/session/{sessionID}/inbox`                                      | `v2.session.inbox.list`                          |
| DELETE | `/api/session/{sessionID}/inbox/{inboxID}`                            | `v2.session.inbox.cancel`                        |
| POST   | `/api/session/{sessionID}/inbox/{inboxID}/steer`                      | `v2.session.inbox.steer`                         |
| POST   | `/api/session/{sessionID}/inbox/{inboxID}/queue`                      | `v2.session.inbox.queue`                         |
| GET    | `/api/session/{sessionID}/instructions/entries`                       | `v2.session.instructions.entry.list`             |
| PUT    | `/api/session/{sessionID}/instructions/entries/{key}`                 | `v2.session.instructions.entry.put`              |
| DELETE | `/api/session/{sessionID}/instructions/entries/{key}`                 | `v2.session.instructions.entry.remove`           |
| POST   | `/api/session/{sessionID}/generate`                                   | `v2.session.generate`                            |
| GET    | `/api/experimental/session/{sessionID}/log`                           | `v2.session.log`                                 |
| POST   | `/api/session/{sessionID}/interrupt`                                  | `v2.session.interrupt`                           |
| POST   | `/api/session/{sessionID}/background`                                 | `v2.session.background`                          |
| GET    | `/api/session/{sessionID}/message/{messageID}`                        | `v2.session.message`                             |
| PUT    | `/api/session/{sessionID}/environment`                                | `v2.session.environment`                         |
| POST   | `/api/session/{sessionID}/view`                                       | `v2.session.view`                                |
| GET    | `/api/session/{sessionID}/message`                                    | `v2.message.list`                                |
| GET    | `/api/model`                                                          | `v2.model.list`                                  |
| GET    | `/api/model/default`                                                  | `v2.model.default`                               |
| POST   | `/api/generate`                                                       | `v2.generate.text`                               |
| GET    | `/api/provider`                                                       | `v2.provider.list`                               |
| GET    | `/api/provider/{providerID}`                                          | `v2.provider.get`                                |
| GET    | `/api/integration`                                                    | `v2.integration.list`                            |
| GET    | `/api/integration/{integrationID}`                                    | `v2.integration.get`                             |
| POST   | `/api/experimental/integration/wellknown`                             | `v2.experimental.integration.wellknown.add`      |
| POST   | `/api/integration/{integrationID}/connect/key`                        | `v2.integration.connect.key`                     |
| POST   | `/api/integration/{integrationID}/connect/oauth`                      | `v2.integration.oauth.connect`                   |
| GET    | `/api/integration/{integrationID}/connect/oauth/{attemptID}`          | `v2.integration.oauth.status`                    |
| DELETE | `/api/integration/{integrationID}/connect/oauth/{attemptID}`          | `v2.integration.oauth.cancel`                    |
| POST   | `/api/integration/{integrationID}/connect/oauth/{attemptID}/complete` | `v2.integration.oauth.complete`                  |
| POST   | `/api/integration/{integrationID}/connect/command`                    | `v2.integration.command.connect`                 |
| GET    | `/api/integration/{integrationID}/connect/command/{attemptID}`        | `v2.integration.command.status`                  |
| DELETE | `/api/integration/{integrationID}/connect/command/{attemptID}`        | `v2.integration.command.cancel`                  |
| GET    | `/api/mcp`                                                            | `v2.mcp.list`                                    |
| PUT    | `/api/mcp/{server}`                                                   | `v2.mcp.add`                                     |
| DELETE | `/api/mcp/{server}`                                                   | `v2.mcp.remove`                                  |
| POST   | `/api/mcp/{server}/connect`                                           | `v2.mcp.connect`                                 |
| POST   | `/api/mcp/{server}/disconnect`                                        | `v2.mcp.disconnect`                              |
| GET    | `/api/mcp/resource`                                                   | `v2.mcp.resource.catalog`                        |
| PATCH  | `/api/credential/{credentialID}`                                      | `v2.credential.update`                           |
| DELETE | `/api/credential/{credentialID}`                                      | `v2.credential.remove`                           |
| POST   | `/api/credential/{credentialID}/activate`                             | `v2.credential.activate`                         |
| GET    | `/api/project`                                                        | `v2.project.list`                                |
| PATCH  | `/api/project/{projectID}`                                            | `v2.project.update`                              |
| GET    | `/api/project/current`                                                | `v2.project.current`                             |
| GET    | `/api/form/request`                                                   | `v2.form.request.list`                           |
| GET    | `/api/session/{sessionID}/form`                                       | `v2.session.form.list`                           |
| POST   | `/api/session/{sessionID}/form`                                       | `v2.session.form.create`                         |
| GET    | `/api/session/{sessionID}/form/{formID}`                              | `v2.session.form.get`                            |
| GET    | `/api/session/{sessionID}/form/{formID}/state`                        | `v2.session.form.state`                          |
| POST   | `/api/session/{sessionID}/form/{formID}/reply`                        | `v2.session.form.reply`                          |
| POST   | `/api/session/{sessionID}/form/{formID}/cancel`                       | `v2.session.form.cancel`                         |
| GET    | `/api/permission/request`                                             | `v2.permission.request.list`                     |
| GET    | `/api/permission/saved`                                               | `v2.permission.saved.list`                       |
| DELETE | `/api/permission/saved/{id}`                                          | `v2.permission.saved.remove`                     |
| POST   | `/api/session/{sessionID}/permission`                                 | `v2.session.permission.create`                   |
| GET    | `/api/session/{sessionID}/permission`                                 | `v2.session.permission.list`                     |
| GET    | `/api/session/{sessionID}/permission/{requestID}`                     | `v2.session.permission.get`                      |
| POST   | `/api/session/{sessionID}/permission/{requestID}/reply`               | `v2.session.permission.reply`                    |
| GET    | `/api/fs/read/*`                                                      | `v2.fs.read`                                     |
| GET    | `/api/fs/list`                                                        | `v2.fs.list`                                     |
| GET    | `/api/fs/find`                                                        | `v2.fs.find`                                     |
| GET    | `/api/command`                                                        | `v2.command.list`                                |
| GET    | `/api/skill`                                                          | `v2.skill.list`                                  |
| POST   | `/api/rpc/{rpcID}/{method}`                                           | `v2.rpc.call`                                    |
| GET    | `/api/event`                                                          | `v2.event.subscribe`                             |
| GET    | `/api/pty`                                                            | `v2.pty.list`                                    |
| POST   | `/api/pty`                                                            | `v2.pty.create`                                  |
| GET    | `/api/pty/{ptyID}`                                                    | `v2.pty.get`                                     |
| PUT    | `/api/pty/{ptyID}`                                                    | `v2.pty.update`                                  |
| DELETE | `/api/pty/{ptyID}`                                                    | `v2.pty.remove`                                  |
| POST   | `/api/pty/{ptyID}/connect-token`                                      | `v2.pty.connect.token`                           |
| GET    | `/api/pty/{ptyID}/connect`                                            | `v2.pty.connect`                                 |
| GET    | `/api/experimental/session/{sessionID}/terminal/read`                 | `server.experimental.persistentPty.read`         |
| GET    | `/api/experimental/session/{sessionID}/terminal`                      | `server.experimental.persistentPty.list`         |
| POST   | `/api/experimental/session/{sessionID}/terminal`                      | `server.experimental.persistentPty.create`       |
| POST   | `/api/experimental/persistent-pty/shutdown`                           | `server.experimental.persistentPty.shutdown`     |
| POST   | `/api/experimental/persistent-pty/handoff`                            | `server.experimental.persistentPty.handoff`      |
| GET    | `/api/experimental/persistent-pty/{ptyID}`                            | `server.experimental.persistentPty.get`          |
| PUT    | `/api/experimental/persistent-pty/{ptyID}`                            | `server.experimental.persistentPty.update`       |
| DELETE | `/api/experimental/persistent-pty/{ptyID}`                            | `server.experimental.persistentPty.remove`       |
| GET    | `/api/experimental/persistent-pty/{ptyID}/snapshot`                   | `server.experimental.persistentPty.snapshot`     |
| POST   | `/api/experimental/persistent-pty/{ptyID}/connect-token`              | `server.experimental.persistentPty.connectToken` |
| GET    | `/api/experimental/persistent-pty/{ptyID}/connect`                    | `v2.persistentPty.connect`                       |
| GET    | `/api/shell`                                                          | `v2.shell.list`                                  |
| POST   | `/api/shell`                                                          | `v2.shell.create`                                |
| GET    | `/api/shell/{id}`                                                     | `v2.shell.get`                                   |
| DELETE | `/api/shell/{id}`                                                     | `v2.shell.remove`                                |
| PATCH  | `/api/shell/{id}/timeout`                                             | `v2.shell.timeout`                               |
| GET    | `/api/shell/{id}/output`                                              | `v2.shell.output`                                |
| GET    | `/api/reference`                                                      | `v2.reference.list`                              |
| GET    | `/api/worktree`                                                       | `v2.worktree.list`                               |
| POST   | `/api/worktree`                                                       | `v2.worktree.create`                             |
| DELETE | `/api/worktree`                                                       | `v2.worktree.remove`                             |
| POST   | `/api/worktree/refresh`                                               | `v2.worktree.refresh`                            |
| POST   | `/api/workspace`                                                      | `v2.workspace.create`                            |
| DELETE | `/api/workspace/{workspaceID}`                                        | `v2.workspace.destroy`                           |
| GET    | `/api/vcs`                                                            | `v2.vcs.get`                                     |
| GET    | `/api/vcs/base`                                                       | `v2.vcs.base`                                    |
| GET    | `/api/vcs/status`                                                     | `v2.vcs.status`                                  |
| GET    | `/api/vcs/branches`                                                   | `v2.vcs.branches`                                |
| GET    | `/api/vcs/diff`                                                       | `v2.vcs.diff`                                    |
| GET    | `/api/debug/location`                                                 | `v2.debug.location.list`                         |
| DELETE | `/api/debug/location`                                                 | `v2.debug.location.evict`                        |
| GET    | `/api/experimental/migration/v1`                                      | `v2.experimental.migration.v1.status`            |
| GET    | `/api/websearch/provider`                                             | `v2.websearch.providers`                         |
| POST   | `/api/websearch`                                                      | `v2.websearch.query`                             |
| GET    | `/api/config`                                                         | `v2.config.get`                                  |

Additional operation in the published SDK: `PUT /api/session/{sessionID}/permission/rules` through `client.permission.rules`. The documented WebSocket upgrade routes `/api/pty/{ptyID}/connect` and `/api/experimental/persistent-pty/{ptyID}/connect` require WebSocket handling after obtaining their connection tokens.

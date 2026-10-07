# Paired browser writes to a headless host

Date: 2026-10-06 (Asia/Shanghai)

## Reproduction environment

- Isolated worktree: `/Users/bytedance/.codex/worktrees/paired-headless-writes/cognia-next`
- Base: `c775468da`; branch: `codex/paired-headless-writes`.
- Browser app: `http://localhost:3107`; headless HTTPS: `27894`; browser listener: `27893`.
- Disposable host data: `.cache/paired-write-e2e` within this worktree.
- Host origin allowlist: `COGNIA_ALLOWED_WEB_ORIGINS=http://localhost:3107`.
- Built `cognia-server` with `TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' cargo build --manifest-path src-tauri/Cargo.toml --bin cognia-server --features workspace-runtime-exec`.
- Built the CLI/brain, linked sidecar packages, webclone, MCP sidecar, VS Code extension host, and code-server extension from this worktree. Started the app through `pnpm dev --port 3107`.
- Paired through the real `/pair` UI using a freshly issued invitation. The browser reached “You're connected” and “Online”.

## Confirmed causes

1. `host_state_submit`'s JSON schema requires `protocolVersion`, while the current TypeScript `HostStateAction` validator rejects that field. The browser reproduced HTTP 422 at `/actions/0`. A generator regression test reproduces the same failure without a running host.
2. The outbound queue generated nanoid idempotency keys, but the Rust remote execution gate requires UUIDs. New queue keys now use UUIDs; old nanoids receive a stable UUID wire representation. The browser's `session_mark_read` returned HTTP 200 after this fix.
3. Manifest refresh disables HostState writes but only the first sync installation re-enabled them. Reconnect now re-cuts existing HostState snapshots before restoring write availability.
4. An authoritative resync failure during the old host lease's remaining lifetime stranded the browser Offline. Transport recovery now retries without advancing its cursor. Retry count resets only after `stream_ready`, preserving exponential backoff across repeated snapshot refusals.
5. Restarted HostState retained business metadata from cached channels. A newer title in the host's sessions table was replaced in the browser by the old HostState title after otherwise successful reconnect. New-generation acquisition now refreshes session metadata and index membership atomically, preserving runtime/draft/revision state and terminal tombstones and recomputing digests.
6. New-chat creation only writes the browser database. The host's sessions table remains empty for the browser-created chat.
7. HostState `message.enqueue` reconstructs send options on the host and drops browser `providerCredentials`. A separately prepared client change keeps paired sends on existing Agent RPC with complete per-turn options.
8. Direct paired Agent RPC does not establish a host WorkSubmission. The existing headless terminal-event transcript persister requires that submission; fixing creation alone is insufficient to persist replies.

## Contract decisions (approved 2026-10-07)

Both decisions were approved and implemented on branch `feat/paired-host-writes`:

- **`protocolVersion` removed** from the per-action `host_state_submit` request schema (`protocol/companion-request-schemas.json`) and every generated artifact regenerated. The device-plane schema keeps its interactive `adminLease`, which the outbound queue attaches (`lib/queue/outbound-approval.ts`).
- **`session.create` seed** (`HostStateSessionSeed`): optional, closed and id-only (`projectId`, `characterId`, `model`, `provider`). The Host keeps only the workspace and agent ids it owns, drops any other (a fresh Host owns none of the browser's), still admits the create, and writes the seeded row from what it kept (`ownedSessionSeed`, `lib/sync/host-state-store.ts`); title-only creates are unchanged. The browser stamps the create from the session index (a new chat has no confirmed channel), waits up to 5 s for the Host's answer before activating the chat, discards the chat on refusal (`hostSessionRefused` diagnostic), stays local against a Host too old to know the intent, and leaves the action queued when the Host is away.

## Validation and remaining work

- Final combined focused run: **900 tests passed across 13 suites**, including the prepared direct-send tests and the completed read/recovery regressions. The schema regression is deliberately excluded from this passing run while its contract change awaits approval.
- Focused ESLint passed for the modified client paths.
- Full `tsc --noEmit --incremental --pretty false`, with the repository's 16 GiB heap setting, reported 112 diagnostics in unchanged paths. None named the modified paths at that checkpoint. The initial default-heap attempt exhausted the Node heap.
- Headless Rust build passed, with existing dead-code/future-incompatibility warnings.
- Live restart verification passed with the rebuilt brain: the same browser returned to Online without re-pairing or reloading, displayed `Paired recovery verified` rather than the stale `Paired recovery baseline`, and resumed `session_mark_read` with HTTP 200. The test changed only a disposable host session's title and updatedAt while the host was stopped, reproducing the underlying-table change from the report. Evidence screenshot: `/tmp/paired-headless-recovery-verified.png`.
- The `gen-companion-api.test.mjs` schema regression was red while the schema decision was pending; it passes since the 2026-10-07 contract change.
- Real model reply remains unverified: this disposable browser has no configured provider key; its first turn stopped at `SubscriptionAccountResolutionError: Could not resolve the active anthropic account.` The user has been asked to identify an existing test key configuration or enter a key through AI Connections.
- End-to-end host chat creation, rename, and persisted model reply required the contract work, completed below.

## Completion (2026-10-07)

- **Cause 7** (credentials dropped): paired sends use direct Agent RPC (`hostStateSendEligible` refuses `pairedHost`), carrying the browser's per-turn options.
- **Cause 8** (no WorkSubmission for direct sends): `send_arm` (`src-tauri/src/companion_api/rpc/chat.rs`) admits every device-originated turn over the writes bridge before the prompt reaches the sidecar (`paired_turn_admit`, `lib/work-submission/paired-turn-adapter.ts`; request/answer shapes in `crates/cognia-companion/src/paired_turn.rs`). Admission writes the user row under the browser's message id (`agent_send.messageId`), accepts, claims and leases a submission, and never freezes `SendOptions`, so no credential reaches the Host's store. A failed handoff seals the admission (`paired_turn_abandon`). The existing terminal-event persister then keeps the reply. The brain's own (service-scope) sends are not admitted twice.
- **Cause 6** (host sessions table empty): closed by the seeded `session.create` above.
- Remaining, pre-existing and unchanged: the brain cannot publish `transcript://revision`, so a browser in timeline mode sees a host-persisted reply on its next page load rather than live. During the turn it shows its own live projection.
- Live paired-browser run with real providers: see below.

## Live verification with real providers (2026-10-07)

A disposable browser paired to a headless host (`pnpm dev:headless`, the host's own env pointing Claude Code at the deterministic fixture `tests/real-e2e/anthropic-fixture.mjs` so any ambient-credential leak would show its marker) ran DeepSeek (Claude) `deepseek-v4-flash` and Kimi For Coding `kimi-for-coding` with keys entered in the browser's AI Connections. Both chats created through the UI were created on the host, answered by their own provider (`DEEPSEEK-UI-OK`, `KIMI-UI-OK`), persisted on the host with user and assistant rows, and their runs settled `completed`. Two concurrent `agent_send` turns with different keys each returned only their own token, never the fixture marker. Neither key appears in the host's synced tables, its data directory or its log, and no request reached `api.openai.com`.

Getting there surfaced six defects, all fixed:

1. **A relay's base URL was dropped at the Rust boundary.** `ProviderCredentials.base_url` (`crates/cognia-sidecar/src/commands.rs`) serialized as `baseUrl` under `rename_all = "camelCase"`, while the renderer and sidecar send `baseURL`, so serde discarded it. An openai-protocol relay's key then went to `api.openai.com`. Now `baseURL` on the wire (`baseUrl` accepted).
2. **Claude-protocol relays resolved as `openai`.** With no stored `apiProtocol`, `resolveFeatureProvider` fell back to the sidecar's id table, which lists none of the "(Claude)" relays. It now reads the catalog entry's protocol first (`lib/ai/provider-consumption.ts`).
3. **The AI SDK Anthropic client got Claude Code's root URL.** Catalog relays store `ANTHROPIC_BASE_URL` roots (`https://api.kimi.com/coding/`); `createAnthropic` appends only `/messages`, so Kimi answered 404. `anthropicSdkBaseURL` (`sidecar/src/providers/provider-protocol.ts`) appends `/v1` when missing, in the sidecar and the renderer.
4. **A paired shell resolved subscription accounts through client-local commands.** `resolveAccountEnv` called `subscription_get_active` / `claude_env_for_account`, which a companion cannot answer, so every Anthropic-family turn failed with `SubscriptionAccountResolutionError`. A companion shell now leaves the account to the host (`lib/claude/env-resolver.ts`).
5. **The brain never saw a device's turn, and could not keep its reply.** `EventBus::publish` addresses every frame carrying `remoteExecutionContext.originDeviceId` to that device, so the brain's service stream never received a paired turn's `claude://message` frames. The service stream now receives every device's sidecar frames, as the desktop renderer does through Tauri (`EventFrame::visible_to_connection`); other device-targeted frames stay with their device. Then the settle transaction (`lib/work-submission/service.ts`) lacked `messageMedia`, `settings` and `projects`, which the transcript write reaches for a session with no project, so the settle aborted with `NotFoundError`; it now has the accept transaction's closure.
6. **New conversations deadlettered.** The host revoked a device's admin leases whenever any one of its event sockets closed (`WsPresenceGuard`, the WebRTC teardown), and the browser's queue kept re-sending the voided lease until the row deadlettered. Leases now go only when the device's last stream closes (`release_device_authority_if_disconnected`, `crates/cognia-companion/src/ws.rs`), and the queue drops a lease the host refused so the retry re-mints it (`noteOutboundApprovalRefused`, `lib/queue/outbound-approval.ts`).

The three issues left open by that run were fixed and re-verified live (DeepSeek and Kimi, a browser that paired without reloading):

- **Quota refusals failed the turn.** The host rejects an over-quota call with `rate_limited` before dispatching it, so the companion transport now waits out the host's short interval and repeats the call (a few rounds, within the call's deadline, same idempotency key), for non-idempotent commands too (`lib/tauri/transport-companion.ts`). Read-only `claude_session_control` methods (the capability probes around each turn) are charged to the read bucket instead of the 10-token mutating one (`request_rate_limit_class`, `is_read_only_control_method`). Two chats sent back to back absorbed seven 429s, four of them on `agent_send`, and both completed.
- **The event stream looped on `resync_required` after a host restart.** The WebSocket resync kept the old process's cursor for channels without a handler, so the reconnect asked the new bus for a seq it had never issued. It now clears every cursor, as the RTC transport already did. The page reconnected about 35 s after the restart, without a reload.
- **Host-kept replies needed a reload.** Two causes. The brain never published `transcript://revision` (only Tauri `emit` was tried); it now goes through the host-neutral publisher, and the bridge allowlists the topic, projecting the payload down to its identity fields. And both transcript sources captured the transport at module load, so a browser that paired afterwards read the web stub (`no_host_transport`, shown as "Retry transcript"). The source now resolves the transport per call and follows a swap. The reply then appeared in the open chat within five seconds.

Also: a headless host no longer tries to publish HostState events to the desktop-only CLI bridge, which logged an "unknown respond command" for every event.

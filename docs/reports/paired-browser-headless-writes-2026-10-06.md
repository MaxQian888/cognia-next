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

## Contract decisions awaiting user approval

No companion contract implementation has been changed.

- Remove the obsolete `protocolVersion` property/requirement from the HostState request schema and regenerate the contract artifacts to match the current TypeScript authority.
- Extend `session.create` with an optional, strictly validated session seed, preserving old title-only requests. Retain model/role/workspace choices, validate host project ownership, and establish host acceptance before client activation. Keep credentials out of replicated HostState actions and host durable context.

The exact seed whitelist and host creation path still need implementation review after approval. The proposed integration uses the existing direct Agent RPC options for credentials and the existing WorkSubmission terminal-event persister for host transcript persistence.

## Validation and remaining work

- Final combined focused run: **900 tests passed across 13 suites**, including the prepared direct-send tests and the completed read/recovery regressions. The schema regression is deliberately excluded from this passing run while its contract change awaits approval.
- Focused ESLint passed for the modified client paths.
- Full `tsc --noEmit --incremental --pretty false`, with the repository's 16 GiB heap setting, reported 112 diagnostics in unchanged paths. None named the modified paths at that checkpoint. The initial default-heap attempt exhausted the Node heap.
- Headless Rust build passed, with existing dead-code/future-incompatibility warnings.
- Live restart verification passed with the rebuilt brain: the same browser returned to Online without re-pairing or reloading, displayed `Paired recovery verified` rather than the stale `Paired recovery baseline`, and resumed `session_mark_read` with HTTP 200. The test changed only a disposable host session's title and updatedAt while the host was stopped, reproducing the underlying-table change from the report. Evidence screenshot: `/tmp/paired-headless-recovery-verified.png`.
- The uncommitted `gen-companion-api.test.mjs` regression intentionally remains red while the schema decision is pending.
- Real model reply remains unverified: this disposable browser has no configured provider key; its first turn stopped at `SubscriptionAccountResolutionError: Could not resolve the active anthropic account.` The user has been asked to identify an existing test key configuration or enter a key through AI Connections.
- End-to-end host chat creation, rename, and persisted model reply require the pending contract work. This task is not complete.

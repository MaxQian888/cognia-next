# Sandbox virtual computer implementation

Date: 2026-10-03. Implements the gaps in the two same-date research notes.
Baseline HEAD: `0be8ce03051529ebaefc982ffe06acb27a0e92ca`; shared working tree with existing edits.

## Acceptance boundaries

- [x] Remote app-session observations/actions never use the host backend. Reuse revision, lineage, token, coordinate and zoom semantics; reject unsupported app-scoped operations truthfully.
- [x] Remote sessions are isolated by connection and invalidated by lifecycle changes and human takeover.
- [x] Desktop viewer continuously refreshes bounded frames, reconnects, exposes explicit human control, renews a backend lease, and prevents agent inputs during takeover.
- [x] Docker execution bounds streams during collection, handles stdin under the deadline, and reaps process trees on timeout, disconnect and cancellation.
- [x] Image identity and authenticated GUI readiness are checked; creation/adoption cannot silently change protocol or isolation.
- [x] Desktop command registration, generated protocol contracts and user-facing translations are complete.
- [x] Provider boundaries are truthful: Docker is the implemented desktop path. E2B Desktop and Lume remain research candidates, with their capabilities disabled until their separate SDK/guest transports are implemented and validated. They are not covered by this Docker implementation.
- [x] Regression tests at runtime routing, lifecycle/execution, UI interaction, and provider boundaries. No coverage collection requested.
- [x] Read-only review for wiring, i18n, static-export and Rust lifecycle hazards, followed by focused repairs.
- [x] Real-image and registry acceptance: actual terminal typing, app-session actions, takeover exclusion, lifecycle and persistent restart passed against the built-in ARM64 image.

## Implementation ownership

- Remote sessions: automation commands/routing and CUA registry/protocol/client; new desktop commands.
- CUA execution: lifecycle and embedded supervisor, image identity attestation.
- Viewer: sandbox connection sheet, reusable viewer and hook, TypeScript client, split automation translations.
- Integration: Tauri command wiring/protocol generation, provider capability boundaries, tests and acceptance report.

## Evidence discovered during implementation

The earlier report overstated E2B availability. `plugins/e2b-sandbox/src/provisioning.ts` deliberately returns false: the workspace and microVM code is dormant until a shipped Node-side SDK bridge exists. Enabling the constant alone is not an implementation.

The initial filesystem probe reports only 6.6 GiB free; avoid large image downloads/cold builds until the required storage is available. Existing user data and caches are not deleted as part of this task.

## Implemented behavior

The settings connection sheet now mounts a read-only desktop viewer with approximately one frame per second. Explicit takeover obtains a backend lease; keyboard, IME text, pointer, drag, double-click and wheel input use that lease. Blur, hidden documents, disconnect, expiry and closing the viewer release it. While a human owns control, agent GUI mutations and shell execution fail instead of racing the human.

The Rust registry gives each connection its own app session. The legacy server exposes one whole-desktop app (`cognia.sandbox.desktop:<connectionId>`); it does not invent per-application accessibility semantics. Unsupported operations fail without using the host backend. Observation tokens are invalidated before mutations; cancelled or unacknowledged mutations quarantine the connection until cleanup or a confirmed stop.

The default image is `cognia-cua-desktop:0.3.46-1`, built on first use from embedded resources. It uses a digest-pinned multi-platform Python base, native Debian Chromium/Openbox/Xvfb and fixed `cua-computer-server==0.3.46`. A private per-container credential protects every HTTP/WebSocket request. Guest applications and command execution do not inherit the token. The server stays in the original nondumpable startup process. Image identity and isolation are attested when retained containers are adopted.

The execution supervisor bounds output while reading, uses an absolute deadline and heartbeat lease, and reaps descendants before confirming timeout. Its trusted interpreter and parent process cannot be replaced or inspected by caller-supplied environment variables. Ambiguous cleanup leaves the connection quarantined.

Saved custom image choices are preserved. Old unauthenticated or identity-less containers must be recreated using a compatible secured image; the backend does not silently weaken admission checks. Users must export any needed guest data before deleting an old connection, since deletion removes its anonymous home volume.

## Acceptance evidence

- Focused TypeScript: 13 suites, 179 tests passed in the final aggregate run. The Node runtime tests emit expected Dexie/audit-persistence warnings; this is not production audit-storage acceptance.
- Scoped ESLint and Prettier, generated companion API check (739 commands / 107 routes), i18n build freshness and i18n lint passed.
- Final Rust automation library suite: 650 passed, 13 opt-in tests ignored. The real graphical acceptance test was then explicitly run and passed separately. Final `tauri-host` check passed, with the existing `block v0.1.6` future-compatibility warning.
- Python endpoint authentication middleware: 3 tests passed. Truncated PNG and excessive decoded-pixel regressions first failed, then passed after full PNG/JPEG decoding and 64 MiB limits were enforced.
- Real Linux supervisor and Docker lifecycle tests passed earlier; these are distinct from graphical desktop acceptance.
- Global TypeScript check completed with 16 diagnostics in unrelated test files, and no diagnostics in this change's files. It is not a passing repository-wide check.
- Native Tauri UI acceptance has not passed: the debug build was stopped after local disk pressure. Component tests do not replace that gate.

### Real graphical desktop

The ignored opt-in Rust test `cua_sandbox::lifecycle::tests::live_builtin_desktop_authenticated_lifecycle_and_real_input` passed on the default Rust test-thread stack in 4.60 seconds, then passed again in 4.91 seconds after screenshot decoder hardening. These are local acceptance samples, not a latency benchmark. It exercised the real registry and container, not a mocked WebSocket:

1. Create/start the hardened image and admit an authenticated connection only after rejecting an unauthenticated probe.
2. Capture a 1280×800 desktop; enumerate its exact virtual application; observe/query the app session and perform a token-bound action.
3. Verify command environments do not contain the server token and the guest cannot read the credential process's `/proc` environment.
4. Acquire human control; reject agent GUI input and shell execution while the lease is active.
5. Click the actual xterm window, type `printf 'native-ui-proof' > /home/cua/ui-proof.txt`, press Enter, and read the resulting file through the same registry connection.
6. Pause/resume, discard the registry and reconnect from a fresh one, stop/start while preserving the home file, then delete and confirm the container is absent.

The captured screen visibly contains the executed terminal command. Synthetic screenshots are retained locally at `.cache/sandbox-virtual-computer-2026-10-03/cognia-cua-desktop-native{,-input}.png`. They show the Linux guest, not the Cognia Tauri window.

Validated image: `cognia-cua-desktop:0.3.46-1`, native `arm64`, local image identity `sha256:7ecc995b38b1059d99500d2427f5680d3840cf5b322f4a9cb413d579113d91cf`. The recipe supports amd64, but no amd64 image was built or tested in this task.

The live run exposed and repaired two integration defects: xterm rejected the pinned server's synthetic key events; Xvfb reset the resource database before its long-lived clients attached. The image now keeps the X server alive and configures both initial and menu-created terminals for those events. Bounded Docker-output buffers were moved to the heap to avoid oversized nested Rust futures.

### Environment recovery and remaining gates

An initial local desktop image export encountered filesystem I/O failures after the host ran out of space. Inspection found a zero-length `gosu` binary. That image was rejected and rebuilt without its corrupted cache layer. The final image passed package/binary validation and the graphical acceptance above. No pre-existing images or user data were deleted to make room.

Docker acceptance uses `DOCKER_CONTEXT=colima`; the user's global context remains `desktop-linux`. Colima was initially stopped and is restored to that state after testing. The task-owned Next/Tauri development processes and disposable containers are stopped/removed. Starting Cognia's desktop feature requires a running Docker engine in its selected context; first use prepares the bundled image and needs registry/package-network access.

Repository-wide typecheck and native Tauri UI/package acceptance remain unpassed gates. This report does not claim a deployed release, a native-window end-to-end pass, E2B/Lume integration, video/audio streaming, semantic Linux accessibility, per-application isolation, or a microVM boundary. The delivered viewer refreshes authenticated screenshots at approximately 1 Hz and the Linux guest uses Docker container isolation.

### Reproduce focused acceptance

```sh
rtk cargo test -p cognia-automation --lib --no-default-features
rtk cargo check -p cognia-automation --features tauri-host
rtk proxy python3 crates/cognia-automation/src/cua_sandbox/image/server.test.py
rtk env DOCKER_CONTEXT=colima cargo test -p cognia-automation --lib live_builtin_desktop_authenticated_lifecycle_and_real_input --no-default-features -- --ignored --nocapture
rtk pnpm i18n:build:check
rtk pnpm lint:i18n
rtk pnpm companion-api:check
```

The live test requires a running Docker engine and an already-built local image; its preflight will not silently download/build one. The ordinary create path builds the image when it is absent. No coverage run, commit or push was performed.

## Continuation: file transfer and recovery

Date: 2026-10-03. The follow-up request extends the existing Docker desktop path.

- Added a file-transfer panel using the existing bounded file picker and shared export flow. It supports regular binary files and empty files up to 8 MiB, validates SHA-256, and pins every request to the exact expected container ID.
- Uploads require a fresh human-control lease, rechecked after awaited target inspection. Guest writes use an unnamed temporary inode and atomic no-overwrite publication; unsupported filesystems fail explicitly. Existing targets and symlink traversal are rejected. Confirmed errors remain retryable; ambiguous process cleanup retains quarantine.
- Download and legacy file reads share the desktop connection lock. Closing or switching the detail view invalidates pending UI work; the save flow checks validity after the native dialog and before writing. It cannot revoke an already-dispatched backend mutation.
- Container deletion requires confirmation, blocks duplicate submissions, preserves failed cleanup for retry, and prevents completion for connection A from closing connection B.
- Health refresh restores verified container identity, clears placement only when absence is confirmed, and clears stale endpoint ports for stopped instances. Unknown health results do not silently rebind the target.
- Both commands are registered in Tauri and its generated ACL, with internal-only protocol dispositions. English and Chinese subsystem documentation now describes the implemented desktop, transfer, authentication and recovery behavior.

### Continuation acceptance

- Final aggregate TypeScript run: 15 suites, 219 tests passed. After correcting a test-only Promise type annotation, the affected shared-export suite passed again: 19 tests. No coverage collection was requested.
- Rust automation library: 659 passed, 13 opt-in tests ignored. The final `tauri-host` check passed with the existing `block v0.1.6` future-compatibility warning.
- The expanded real-container acceptance test passed in 9.06 seconds against the same ARM64 image. In addition to desktop/authentication/control/lifecycle behavior, it round-tripped an exact 8 MiB binary file and an empty file, rejected a replaced container ID, preserved existing files on collision, verified that a killed upload left no partial filename, and retained file bytes/hash across restart. This single local run is acceptance evidence, not a performance benchmark.
- Scoped ESLint, Prettier, diff whitespace checks, companion API generation consistency, i18n freshness and i18n lint passed. Review findings about post-inspection lease expiry and stale transfer UI state were repaired and regression-tested.
- Colima was restored to its original stopped state, disposable acceptance containers were removed, and the global Docker context remains `desktop-linux`.

- The final repository-wide TypeScript check completed with the same 16 diagnostics outside this change and no diagnostics in the changed files. Its exit code is 2; it is not a passing global gate. The log is `.cache/sandbox-virtual-computer-2026-10-03/typecheck-continuation-final.log`.
- `pnpm docs:build` passed, including documentation TypeScript checking, generation of 2,004 static pages, and search-index preparation. The build emitted platform-package and Fumadocs dynamic-import cache warnings. The log is `.cache/sandbox-virtual-computer-2026-10-03/docs-build-continuation.log`.

Native Tauri window/package acceptance remains unverified under local disk pressure; this continuation does not enable E2B, Cua Cloud or Lume.

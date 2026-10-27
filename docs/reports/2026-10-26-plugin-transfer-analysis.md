# Plugin transfer limits and optimization analysis

Date: 2026-10-26 (Asia/Shanghai). Scope: current working-tree implementation, not a released-binary acceptance claim. Product code is unchanged.

## Assessment

The 100 MiB compressed cogpack limit is defensible as a guard for the current buffered implementation. It is unsuitable as the permanent, universal limit for every plugin set and Host. Raising it alone would amplify existing memory, recovery, authorization, and throughput problems. First fix the protocol inconsistencies; then introduce a negotiated, streamed transfer path and select its limits from measured package sizes and Host resource budgets.

There is no evidence here that the user's actual installed package exceeds 100 MiB. An inventory of 74 tracked plugin directories found the largest source/assets tree at 1.951 MiB, excluding ignored dependencies, compiled artifacts and third-party installed bundles. This is not a distribution-size survey and cannot justify a universal product limit.

## Current contract and boundaries

| Boundary                     | Current behavior                                                                                                                                      | Owning source                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole cogpack                | 100 MiB compressed; 300 MiB expanded; 8,192 archive entries; TypeScript import checks compression ratio 200 and path depth 32                         | `lib/plugin/cogpack/package.ts:42`; `packages/plugin-contract/src/lib/packaging/signed-zip.ts`                                                             |
| Native plugin tree export    | Each plugin tree is read into Base64 file records; 300 MiB and 8,192 files per tree                                                                   | `crates/cognia-plugin-runtime/src/plugin_tree.rs`                                                                                                          |
| Transfer packaging           | Every required plugin is embedded into one newly signed cogpack, even when its origin is reproducible                                                 | `lib/remote-host/migration/plugin-transfer.ts:144`                                                                                                         |
| Upload                       | 32 KiB raw chunks in Base64 JSON, strictly sequential offsets; 8 active uploads; fixed 30-minute age limit                                            | `crates/cognia-plugin-runtime/src/cogpack_transfer.rs:40`                                                                                                  |
| Public HTTP                  | Normally 64 KiB request body; plugin transfer commit has no special body-size allowance                                                               | `crates/cognia-companion/src/server.rs:59`                                                                                                                 |
| Mutation quota               | Plugin upload writes use the ordinary mutation bucket: burst 10, refill 1/s                                                                           | `crates/cognia-companion/src/remote_execution.rs:296`; `crates/cognia-companion-rpc/src/rpc.rs:3207`; `crates/cognia-companion-security/src/rate_limit.rs` |
| Authorization                | Migration requests a 15-minute admin lease; every upload write/abort/commit is an interactive Host-admin command                                      | `lib/remote-host/migration/service.ts:76`; generated command catalog                                                                                       |
| Disk durability              | Every chunk opens/seeks/writes/syncs the file while holding the upload registry mutex                                                                 | `crates/cognia-plugin-runtime/src/cogpack_transfer.rs:165`                                                                                                 |
| Receiving/installing         | Upload is read fully into a Vec; requested trees are inflated into memory before installation; temporary materialization and installation copy follow | `crates/cognia-plugin-runtime/src/cogpack_transfer.rs:217,481,536`                                                                                         |
| Recovery                     | Upload state is in memory; startup deletes old `.upload` files; the sender aborts after an unrecovered chunk error                                    | `crates/cognia-plugin-runtime/src/cogpack_transfer.rs:77`; `lib/remote-host/migration/plugin-transfer.ts:106`                                              |
| RPC retry protection         | Durable, device/method/key-scoped outer RPC ledger; a logical transport call reuses its key across transport fallback                                 | `crates/cognia-companion-security/src/idempotency.rs`; `lib/tauri/transport-companion.ts:1043`                                                             |
| Transfer-level result memory | Additional 64-entry in-memory map keyed by operation id; it is not a complete crash-resumable transfer journal                                        | `lib/plugin/cogpack/transfer-install.ts:100`                                                                                                               |
| Runtime readiness            | Headless installation publishes a runtime event and returns; Node reconciliation/activation is asynchronous                                           | `crates/cognia-companion-rpc/src/rpc/plugins.rs:327`; `lib/headless/runtimes/plugin-runtime.ts:110`                                                        |

MiB means 1,048,576 bytes. The compressed limit is per cogpack, not per plugin. It is also not identical to the existing single-plugin download guard of 128 MiB compressed / 512 MiB unpacked in `crates/cognia-plugin-runtime/src/archive_limits.rs`.

## Findings supported by the current source

### F1 — P1: A small, valid package can exceed the install control request limit

After uploading the archive, `transferPlugins` sends the entire manifest again inside `plugin_cogpack_transfer_install`. Every embedded file contributes a path, SHA-256 and size. That public HTTP route remains under the 64 KiB cap.

A local probe used the production `validatePluginManifest`, `exportCogpack` and `inspectCogpack`, an included `index.js` entrypoint, actual Ed25519 signing and exact UTF-8 JSON serialization. This does not establish runtime activation:

| Files | Raw fixture bytes | Signed archive bytes | Install request bytes | Over 65,536 bytes |
| ----- | ----------------- | -------------------- | --------------------- | ----------------- |
| 2     | 434               | 1,146                | 979                   | No                |
| 256   | 5,916             | 57,930               | 36,031                | No                |
| 400   | 9,084             | 90,107               | 55,903                | No                |
| 600   | 13,484            | 134,727              | 83,503                | Yes               |

The fixture is about 131.6 KiB compressed, far below 100 MiB. Its install control request exceeds the public HTTP cap. This reproduces the size mismatch, not an authenticated live Host HTTP 413. Exact thresholds depend on path lengths and metadata; 600 is an example, not a universal boundary.

**Required correction:** commit using a caller-owned staged-upload handle and bound archive identity. The Host reads the bounded manifest from its staged archive, verifies signature/trust and applies its own policy before installing. Do not send the whole manifest in a small control request or globally enlarge every RPC body limit. The internal Rust-to-TypeScript manifest bridge also needs an explicit manifest-byte budget.

### F2 — P1: Transfer quotas and expiry prevent approaching the advertised limit on defaults

The shared execution classifier and the legacy HTTP classifier do not classify plugin upload writes as bulk transfer. They use the ordinary mutating bucket. With 32 KiB chunks and an initially full 10-token bucket:

| Package             | Chunk writes | Base64 payload alone | RTT-only floor at 100 ms | Mutation-quota floor |
| ------------------- | ------------ | -------------------- | ------------------------ | -------------------- |
| 1 MiB               | 32           | 1.333 MiB            | 3.2 s                    | 22 s                 |
| 10 MiB              | 320          | 13.334 MiB           | 32 s                     | 310 s                |
| 100 MiB             | 3,200        | 133.337 MiB          | 320 s                    | 3,190 s              |
| 1 GiB, hypothetical | 32,768       | 1,365.375 MiB        | 3,276.8 s                | 32,758 s             |

These are separate analytical floors, not observed timings and not additive benchmark results. They exclude open/commit calls, other device writes, disk sync and signing/compression. Calls can fail earlier if retry budgets are exhausted.

3,190 seconds is about 53.2 minutes. The upload expires 30 minutes after creation, even while it is making progress, and the migration admin lease lasts 15 minutes. The default successful-write budget therefore conflicts with the top-end package limit. A fresh 15-minute lease admits only about 28 MiB of chunk writes in the idealized quota model, before accounting for other calls.

**Required correction:** one consistent bulk-transfer quota policy for HTTP/RTC/relay execution, with per-device and aggregate byte/concurrency limits. Preserve normal mutation limits. Separate transfer retention from authorization: an expired lease must stop privileged mutation without destroying resumable bytes; fresh explicit authorization is required to continue/commit. Never silently extend or bypass an admin lease.

### F3 — P2: Stop-and-wait, Base64 and synchronous disk flushing dominate large transfers

The sender awaits each chunk before sending the next. 100 MiB needs 3,200 request/response cycles and 3,200 `sync_data` calls, with about one-third Base64 expansion before JSON/headers. A global upload mutex covers disk writes and sync, serializing otherwise independent uploads.

**Required correction:** keep the old command's strict ordering intact. A versioned data path can negotiate larger logical chunks, use native binary HTTPS bodies when supported, and use an ordered binary RTC/relay stream with bounded buffering. Logical chunks and RTC frame sizes are separate; respect the carrier's negotiated message limit. Never parallelize current `write_chunk` calls with `Promise.all`: it requires exact next offsets.

Group durable checkpoints can replace per-frame fsync only with precise ACK semantics: `durableOffset` advances after data and checkpoint metadata are durable. Bytes accepted into volatile buffers must not be represented as crash-durable. Recovery validates/truncates any uncheckpointed tail. Keep a per-transfer serialization primitive, bounded in-flight bytes, and a Host-wide install semaphore.

### F4 — P2: The flow is chunked on the wire but buffered at both endpoints

Native export returns complete Base64 trees to the renderer. The renderer decodes all files and generates the whole ZIP in memory with DEFLATE level 9. The compressed-size check occurs after ZIP generation; export does not apply the same aggregate expanded-size check as import. Multiple individually legal trees can therefore be expensive before an archive is rejected.

On receipt, `take` reads the complete compressed archive; `install_transfer` holds all requested expanded trees before writing them. Compressed bytes, decoded trees, strings, temporary files, copied prepared trees and an older installation can coexist. The exact peak RSS/storage multiplier is unmeasured and must not be quoted as a benchmark. Active uploads are bounded, but consuming an upload removes it from that registry before installation; eight active uploads do not bound concurrent installs.

**Required correction:** native snapshot/archive creation to a staged file; incremental hashing; bounded file-backed reads; streaming extraction into isolated staging with cumulative budgets; verify every member before switching any requested member. Preserve the current no-install-on-archive-integrity-failure guarantee. Reserve scratch space for archive, extracted/prepared files, retained old versions and journal headroom before receiving bytes. Avoid unbounded worker queues and whole-archive IPC responses.

### F5 — P2: RPC idempotency exists; transfer resume and recovery remain incomplete

The outer RPC ledger is durable and validates request digests, so claiming there is no idempotency would be incorrect. It protects retries within a logical call, including transport fallback. It is not a resumable upload protocol: there is no status/resume endpoint, upload metadata disappears on restart, and the sender creates a new transfer operation on a new invocation. The extra TypeScript answer map cannot substitute for durable transfer status.

**Required correction:** persist transfer identity, owner/account/Host binding, immutable archive digest/length, durable offset, expiry and state. Expose authenticated status, resume and cancellation. Repeated chunks with the same range and digest may replay safely; conflicting data must fail. Bind an operation id to the request digest and principal, and reconcile pending installation outcomes after crashes instead of blindly re-executing them. Reuse the existing RPC ledger rather than adding a second incompatible general-purpose idempotency layer.

### F6 — P1/P2: Installation, activation and rollback are different outcomes

A headless Host returns the installed-file result and reconciles its runtime asynchronously. Activation errors are logged; the migration preflight reads plugin id/version, not a proof that required contributions are ready. Thus a successful transfer receipt alone does not establish that dependent work can run. This is a source-derived integration risk, not a reproduced live migration failure.

The package's `minHostVersion` is parsed but the transfer install function does not compare it to the Host version. Same-version/different-content installations are also indistinguishable to the current migration version check. The transfer path replaces each plugin tree atomically, but it does not retain the old tree until runtime activation succeeds; this differs from the richer desktop staged updater's rollback flow.

**Required correction:** preflight Host/runtime compatibility and capacity; identify the requested immutable artifact; return/query per-plugin `staged`, `installed`, `activating`, `ready` or `failed` states. Move/arm dependent work only after its required capabilities are ready. Reuse staged-update rollback ownership and keep prior files until activation/health verification settles. Preserve explicit partial results for independent members; do not imply that the entire cogpack switch is atomic.

### F7 — P1: Cogpack trust does not produce the receipt required by desktop discovery

The transfer checks the cogpack signature and Host trust policy, but `install_member` removes the supplied verification receipt and writes no replacement (`cogpack_transfer.rs:555-560`). Desktop discovery then invokes `verifyPluginSignature` (`manager.ts:2598`); when signatures are required, `signature.ts:194-219` accepts a Host receipt verified via signature and otherwise refuses the install. The verifier caches refusals rather than successful verification (`signature.ts:288`), so a previous successful verification does not reliably conceal this missing receipt. Managed IDE local-dev trust is a separate explicit exception.

A cogpack accepted by its own trust check can therefore replace a previously working plugin with files that the desktop cannot rediscover under signature-required policy. This is established by the owning code paths, not a live desktop reproduction. The existing tests inject activation/trust seams and do not prove this integration boundary.

**Required correction:** preserve Host-owned receipt authority. After verifying the cogpack and the actual member bytes, create an attestation binding the cogpack fingerprint, accepted signer, member tree digest and installed version. The runtime verifier must recognize that provenance under explicit Host policy; a cogpack signer must not be silently represented as the original plugin author. Never copy the sender's receipt, accept checksum-only provenance as a signature, disable the lifecycle verification gate, or add the sender to the trusted ledger automatically. Keep the old installation until receipt validation and activation have succeeded.

### F8 — P1/P2: Whole install-tree export does not distinguish distribution content from local state

`plugin_tree.rs:32,67-95` excludes `.git` and symlinks, then selects every other regular file. `transferPlugins` embeds that complete selection. This can include local runtime state, credential files or host-specific dependencies if a plugin writes them beneath its install root. No actual secret-bearing installation was inspected; this is a confirmed selection behavior with a conditional disclosure and package-bloat risk. Omitting config fields from the cogpack does not sanitize raw files.

**Required correction:** define an installable distribution-file selection contract before moving archive creation into native code. Prefer an immutable publisher artifact or declared distribution list; exclude Host verification receipts, credentials and mutable state, and show the selected files/size for local/private exports. Preserve required bundled dependencies and offline resources: indiscriminately deleting every `.venv`, `node_modules` or similarly named directory can break a legitimate plugin. Ambiguous legacy trees need explicit review or a refusal with an actionable reason, not an automatic full-directory upload. A dummy credential/state fixture must demonstrate exclusion without inspecting real secrets.

### F9 — P1 candidate: Export containment does not pin ancestor directories

The exporter first collects absolute paths, then reads them later. `read_regular_file` checks final-file metadata and the opened file's identity, but ancestor directories are resolved again. If a running plugin replaces a previously walked subdirectory with a symlink before that metadata check, both the metadata lookup and open can refer to the same outside file and satisfy the inode comparison. The later `strip_prefix` is lexical, not a check of the opened file's ancestry (`plugin_tree.rs:137-164,184-197,217-219`).

This is an independently identified, source-derived containment risk; no exploit or platform-specific race test ran. It must not be reported as observed data exfiltration. A native snapshot should use descriptor-relative traversal that refuses symlink ancestors, or an equivalently verified snapshot mechanism. Test with a controlled dummy outside file and a deterministic directory-swap seam; keep platform-specific behavior explicit. A new snapshot must not assume that reusing the existing read path proves race-safe containment.

## Recommended delivery sequence

### Phase A — Make the current-sized path correct before increasing limits

Owner: plugin runtime and companion execution maintainers.

- Correct manifest/control-body handling and share one bulk-transfer quota classification across carriers.
- Close the cogpack-to-runtime attestation gap and apply a reviewed distribution-file selection policy before sending raw install trees.
- Reproduce the ancestor-directory swap candidate using dummy files and close the export-containment gap before calling native snapshots safe.
- Validate client chunk negotiation and acknowledged offsets; report actionable size, quota and authorization expiry errors before expensive packing where possible.
- Add status/readiness checks and authorization-expiry recovery. Keep old clients working at their existing limits; advertise additive capabilities before a client uses new commands.
- Retain the legacy 100/300 MiB guard. Align/document the different single-plugin and cogpack limits rather than changing every cap to one number.

Acceptance: the corrected 600-file signed fixture installs over public HTTP under signature-required policy and can be rediscovered after restart; forged sender receipts never grant trust; dummy credentials/state do not travel while explicitly bundled runtime dependencies do; a 100 MiB incompressible fixture no longer competes for the ordinary 1/s mutation bucket; authorization expiry preserves staged bytes but does not authorize a commit; activation failure never arms dependent work.

### Phase B — Stream and resume before offering larger packages

Owner: native packaging and transport maintainers.

- Add a versioned Host capability reply with transfer version, compressed/expanded/manifest/file limits, allowed carriers, chunk/frame limits, maximum in-flight bytes, retention and current available capacity.
- Keep control messages small. Reuse the existing Companion authentication and authorization model for a bounded native data endpoint; do not add a Next.js runtime server to the static-export app.
- Persist upload state and an installation journal; use file-backed source/sink paths and incremental hashes. One ordered writer per transfer is sufficient initially; out-of-order multipart upload is not necessary for the first version.
- Reuse existing install commit/pending-activation fencing and staged-update rollback ownership. Serialize each plugin's lifecycle transition and compare the expected prior artifact/generation before commit so a stale plan cannot overwrite a concurrent administrator's update.
- Use bounded binary transport when available, with Base64 RPC as a compatibility fallback. Keep the same transfer identity across route changes, with one writer generation/fence so old and new carriers cannot append concurrently.
- Apply per-device/account/Host quotas, space reservations and install concurrency. Cancellation and periodic expiry cleanup release reservations; progress cannot extend authorization.

Acceptance: interrupt/restart at receive, verify, replace and activation stages; resume from the last durable offset without reuploading acknowledged data; reject conflicting replay, cross-device/account handles and stale writer generations; run LAN HTTPS, RTC direct and relay tests. Measure RSS/scratch and UI responsiveness with 100/256/512 MiB and 1 GiB fixtures admitted only by an explicit test Host policy. No larger default is selected before those results exist.

### Phase C — Avoid bytes that do not need to travel

Owner: package distribution maintainers.

- Reuse recorded full-commit/digest origins and Host-local verified artifacts before transferring embedded files. This extends the existing cogpack reference/embedded model, not a new distribution platform.
- Host-side fetching must be explicitly allowed and meet Host SSRF, credentials and publisher trust rules. The sender's signature/trust cannot authorize arbitrary download URLs or automatically add a publisher to the Host ledger.
- Retain embedded transfer for private/offline/local plugins. A publisher may separate large models/media/runtime resources into immutable, signed/digest-pinned artifacts; offline export must still be able to carry everything required. Never silently drop resources or introduce floating URLs.
- Start with whole-artifact hash reuse. File/block deltas and cross-account/global caches are deferred until measured repeat-transfer volume warrants their complexity and isolation costs.

Acceptance: identical artifact needs no upload; equal semver/different digest is detected; reference denial/offline failures offer the full embedded route; a cache hit is integrity-checked and authorized for the requesting account.

## Alternatives

| Option                                                                           | Result                                                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Change 100 MiB to 1 GiB only                                                     | Reject: leaves quota/TTL/control-body failures and increases buffered memory/scratch exposure                                 |
| Remove all limits                                                                | Reject: loses finite memory/disk/CPU protection against untrusted archives                                                    |
| Parallelize existing chunk RPCs                                                  | Reject: strict next-offset contract rejects out-of-order writes                                                               |
| Require every plugin to be under 100 MiB                                         | Reject as a universal product rule: offline/native/media use cases can legitimately need more; gather actual package evidence |
| Host fetches every plugin reference                                              | Incomplete alone: private/local/offline sources remain, and fetch authorization/security must be preserved                    |
| Introduce a complete new generic transfer platform immediately                   | Defer: reuse Companion, existing file-backed transfer experience and cogpack contracts; unify only proven common mechanisms   |
| Correct current flow, add bounded streaming/resume, then negotiate larger limits | Recommended; larger defaults remain a measurement decision                                                                    |

## Verification and evidence

- Probe: `.cache/plugin-transfer-analysis/probe.ts`; output: `.cache/plugin-transfer-analysis/probe-results.json`; Node v26.12.1. Production signing/export/import functions are used. No external Host or plugin files are changed by the probe.
- Focused existing Jest results on Node v26.12.1: **11 suites and 127 tests passed**, 3.07 seconds, recorded in `.cache/plugin-transfer-analysis/focused-tests.log`. These tests do not establish large-file HTTP, quota, crash/restart, memory or real-carrier acceptance.
- Product code, protocol constants and generated catalogs are unchanged. No full build/typecheck, coverage or real two-machine install is claimed for this analysis-only task.

## Independent adversarial review

The first pass used a fresh-context, read-only reviewer over the whole report and its owning source. The reviewer confirmed the HTTP body-limit and mutation-classifier evidence, then identified the following omissions. The main session re-read the owning code before accepting them.

| Review item                                                      | Classification                                            | Resolution                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original package fixture omitted a frontend entrypoint           | Valid and actionable evidence defect                      | Added `index.js`, metadata, compatibility declarations and a production manifest-validation assertion; reran the probe and replaced all measured sizes. Runtime activation is still explicitly unverified. |
| Cogpack verification did not produce a runtime signature receipt | Valid and actionable implementation/design gap            | Added F7, Host-owned attestation and strict-policy/restart acceptance. No sender receipt or policy bypass is allowed.                                                                                      |
| Native archive proposal lacked a distribution-file contract      | Valid and actionable design gap                           | Added F8 and credential/state dummy-fixture acceptance while retaining explicitly required bundled dependencies.                                                                                           |
| Ancestor directory can change between tree walk and read         | Valid source-derived candidate; dynamic proof outstanding | Added F9 and an explicit containment reproduction/repair obligation; no exploit outcome is claimed.                                                                                                        |

A bounded second pass of the amended artifact found no remaining material analysis/design blockers within its read-only scope. This is completion of the analysis review, not acceptance of the unchanged production implementation. The user explicitly chose to skip the optional cross-model review; no external model CLI was invoked.

## Sources

- [ADR-0209: cogpack and cogset ownership](../content/docs/en/adr/0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs.md).
- [Always-on Host implementation plan](../plans/2026-10-10-always-on-host.md).
- [tus resumable upload protocol](https://tus.io/protocols/resumable-upload): reference for explicit offset/status, limits, expiry and checksum semantics; adopting its entire HTTP protocol is not a prerequisite.
- [W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount): carrier backpressure uses buffered-amount thresholds; it does not itself provide crash-durable upload ACKs.

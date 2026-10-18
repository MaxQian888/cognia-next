# Integrate existing VS Code tunnels through Cognia's remote-host registry and workspace interfaces

> **Superseded — 2026-10-18 by [ADR-0235](../content/docs/en/adr/0235-a-vscode-tunnel-installs-a-host-and-is-one-more-route-to-it.md)** and the [host bootstrap plan](./2026-10-18-vscode-tunnel-host-bootstrap.md). The design review rejected treating the tunnel as an unmanaged workspace provider: the tunnel now installs a full Cognia Host and serves as a Host-published fallback route. This document is kept as history.

| Field           | Value                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status          | Superseded by ADR-0235 (2026-10-18)                                                                                                                                                                                                                                                                                                            |
| Date / author   | 2026-10-18 / Codex                                                                                                                                                                                                                                                                                                                             |
| Request         | Design an integration based on the successful TypeScript SDK probe; reuse remote hosts, files, and command execution; do not implement yet                                                                                                                                                                                                     |
| Depth           | Heavy: provider identity, credentials, native/Node IPC, persisted metadata, filesystem/process contracts, and UI                                                                                                                                                                                                                               |
| Source baseline | Shared `dev` working tree; HEAD observed as `262ee1d303d98ad3688ef6038a2ebda9549bc7ca` during the audit. Source observations include the working tree and are not a clean-commit attestation                                                                                                                                                   |
| Review roles    | Remote-host maintainer; files/terminal maintainer; native/sidecar maintainer; security reviewer; product reviewer                                                                                                                                                                                                                              |
| Related         | [ADR-0082](../content/docs/en/adr/0082-remote-development-remote-host.md), [ADR-0172](../content/docs/en/adr/0172-remote-access-is-verified-not-assumed.md), [ADR-0221](../content/docs/en/adr/0221-a-remote-sandbox-is-a-provider-behind-the-same-seam.md), [SDK source audit and live validation](../research/2026-10-18-dev-tunnels-sdk.md) |

> **Recommendation.** Add `vscode-tunnel` as a provider in the existing remote-host registry, and open it through the existing isolated target/channel lifecycle. Bind its file and command operations to an explicit workspace context. Keep full Cognia Host activation and application-state ownership separate.
>
> **First delivery.** Desktop connection/discovery, a read-only browser for a user-selected remote directory, and explicitly approved one-shot commands on a trusted user-owned host. Reuse the file/command facades and UI, with explicit capability and guarantee checks.
>
> **Reason.** The SDK probe proved authentication, tunnel discovery, protocol-6 connection, directory metadata/listing, and successful process execution. It did not prove the confinement, atomic writes, termination, PTY, or Agent contracts required by other Cognia features.
>
> **Review decisions.** Approve workspace-scoped attachment, the trusted/unconfined first-delivery scope, and an explicit host-owned authentication choice. Editing, unattended Agent execution, and full Host behavior have separate release gates below.

## 1. The successful probe establishes connectivity and two useful operations

The existing tunnel can carry native file/process requests without embedding the full VS Code workbench. The isolated TypeScript experiment on 2026-10-18 used Microsoft SDK `1.3.61`, received CLI `1.142.0` / protocol `6`, listed a test workspace with four entries, and ran `printf` plus `pwd` with exit code `0` and empty stderr. It used an existing authenticated GitHub CLI session, opened no local forwarded-port listeners, disposed the SDK, and exited successfully. It did not alter Cognia implementation or dependencies. See the [recorded validation](../research/2026-10-18-dev-tunnels-sdk.md#live-validation-follow-up--2026-10-18).

| Evidence                                                                                  | Status                                                    | Design consequence                                                                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SDK discovery and connect-token acquisition with an existing GitHub identity              | Confirmed by live probe                                   | Reuse is technically viable; a dedicated Cognia OAuth application is still unverified         |
| `fs_stat`, `fs_readdir`, `spawn`, stdout/stderr EOF and process result                    | Confirmed by live probe                                   | Directory listing and one-shot command workflows have an implementation foundation            |
| `fs_read` / binary streams                                                                | Confirmed in upstream source; not exercised by that probe | Actual text/binary preview requires a live acceptance test before advertising read capability |
| `fs_write`, rename, delete and process-control methods exist upstream                     | Confirmed in source only                                  | Existence of a method does not establish Cognia-equivalent semantics                          |
| Secure root confinement, CAS writes, ignore rules, watcher, PTY, timeout kills, reconnect | Not verified                                              | Do not advertise or approximate these contracts in the first delivery                         |

The current server accepts raw MessagePack control traffic on logical port `31545`; its `spawn` operation supplies stdin/stdout/stderr streams and an exit result. SDK port streams and the CLI control protocol are separate layers. Freeze both SDK and protocol fixtures; do not infer compatibility from a CLI version string alone. [Pinned upstream SDK/CLI sources](../research/2026-10-18-dev-tunnels-sdk.md#existing-vs-code-tunnel-discovery-authentication-and-protocol)

## 2. Reuse the existing ownership model without granting a tunnel full Host status

The remote-host registry is the correct identity and connection entry point. Global remote-host activation is a different operation: it changes ownership of Cognia application behavior.

| Existing owner                                                            | Verified current behavior                                                                                                                              | Reuse / required extension                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [remote-host store](../../stores/remote-host/remote-host-store.ts)        | `RemoteHost.config` is `CompanionConfig`; add/activate assumes device keys, `CompanionTransport`, capability probes, and a Companion terminal endpoint | Provider-discriminated records; retain existing Cognia branch unchanged                                          |
| [isolated target](../../lib/remote-host/target-transport.ts)              | `openRemoteHostTarget` opens a target without changing global routing                                                                                  | Shared provider-session construction; purpose/capability checks before returning a usable channel                |
| [management channel](../../lib/remote-host/management-channel.ts)         | Per-host reference counting and a 150-second idle lease; staleness uses Companion `deviceId`                                                           | Reuse lease ownership; extend stale identity to account/provider/credential generation                           |
| [RoutingTransport](../../lib/tauri/transport-routing.ts)                  | Routes execution-classified commands and all logical event subscriptions to the globally active Cognia Host                                            | Preserve for full Cognia Hosts; do not install a tunnel in this global slot                                      |
| [workspace files](../../lib/files/workspace-fs.ts)                        | Existing typed operations call the process-global `transport`; root policy is implemented by Rust/Companion                                            | Factor a bound caller inside this facade; existing exports retain their default transport                        |
| [one-shot execution](../../lib/terminal/remote-api.ts)                    | `RemoteExecRequest` / `RemoteExecResult`, including kill-after timeout semantics                                                                       | Reuse validation, rendering and successful-result shape; preserve guarantee differences through a scoped outcome |
| [headless execution policy](../../lib/terminal/headless-exec.ts)          | Unattended switch, command classification, ask policy and audit; desktop currently reaches raw local `invoke`                                          | Reuse policy; explicit target must be resolved before selecting native vs remote execution                       |
| [remote-host credential vault](../../lib/remote-host/credential-vault.ts) | Secure-storage reference with a device-JWK-specific payload                                                                                            | Extend typed credential ownership; do not store GitHub tokens in Companion fields                                |

Global activation currently also affects connector/bot runtime teardown, session unread ownership, host-state mirroring and scheduler placement. A tunnel cannot answer those Cognia protocols. Relevant owners include [connector runtime](../../components/connectors/connector-bus-provider.tsx), [bot initializer](../../components/providers/initializers/bot-runtime-initializer.tsx), [outbound/mirror runner](../../components/providers/companion-outbound-runner-provider.tsx), [session state](../../lib/db/session-state.ts), and [scheduler target](../../lib/scheduler/scheduler-host-target.ts).

Two similarly named modules are not the intended seam: [plugin WorkspaceBackend](../../lib/github/workspace.ts) owns repository clone/publish/remove; [WorkspaceRuntimeBackend](../../crates/cognia-external-agent/src/workspace_runtime_backend.rs) owns persistent external-agent sessions and runtime-specific `/workspace` placement. This feature attaches an existing directory and executes bounded one-shot operations. It does not create a sandbox, clone, manage a worktree, or host a persistent Agent.

### Invariants

1. One remote-host registry; no second tunnel-host database.
2. A workspace attachment never changes `activeHostId`, `setActiveRemoteTransport`, Companion pairing, or application-state runtime-target context.
3. A scoped request captures account, host, workspace binding, credential epoch, and routing generation before the first await. No path, cache entry or result is identified by a remote path alone.
4. Unsupported, stale, disconnected, or uncertain requests never run locally or on another pairing.
5. Capability names describe delivered guarantees. `spawn` is not a PTY or sandbox; a chosen directory is not an OS security boundary.
6. No model/provider credentials, local inherited environment, or workspace vault secrets are automatically forwarded to the tunnel.
7. The tunnel remains the user's existing service. Disconnect/removal does not stop `code tunnel`, delete remote files, or unregister the remote machine.

## 3. Use one provider session behind an explicitly bound workspace interface

The integration adds provider-specific mechanics behind existing identity, lease and file/command owners. Provider-sensitive code stays at connection/session construction and result translation.

```text
Devices / existing remote-host registry
                 |
        openRemoteHostTarget(purpose=workspace)
                 |
      shared provider session / reference-counted lease
                 |
       captured workspace operation context
          /                         \
 workspace-fs bound caller     scoped command executor
          \                         /
            local trusted sidecar IPC
                 |
      TypeScript SDK + protocol-6 adapter
                 |
       existing Microsoft Dev Tunnel
                 |
       existing remote VS Code CLI

Full Cognia Host activation ---> existing RoutingTransport / application ownership
                                (not changed by workspace attachment)
```

Figure 1: The same registry and session lifecycle serve the new provider, while explicit workspace requests stay separate from full application ownership.

### 3.1 Provider records separate identity from credentials and runtime evidence

Extend the existing registry type with a discriminant. These are proposed fields, not existing code:

| Shared fields                                                                        | Cognia provider branch                                                                 | VS Code tunnel branch                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `label`, account ownership, timestamps, connection state, credential reference | `provider: "cognia"`; existing Companion config, pairing identity and feature manifest | `provider: "vscode-tunnel"`; GitHub numeric account identity, cluster ID, service tunnel ID, display name |
| Runtime evidence is memory-only                                                      | Cognia capability / feature-manifest probes                                            | Negotiated CLI/protocol version, adapter operation set, liveness and limitations                          |

Tunnel deduplication uses `(Cognia account scope, GitHub numeric user ID, clusterId, tunnelId)`. A friendly machine name is a discovery filter and label, never a stable authority. If it resolves to a replacement ID, require reselection; do not silently retarget a saved record.

`alwaysOn`, scheduler eligibility, remote secrets, host update, bot/connector migration, external-agent process plane and managed-task-workspace features remain Cognia-only. Do not fabricate a `CompanionConfig`, ES256 device identity, Cognia manifest, Host grant, or `adminLease` for a tunnel.

### 3.2 Reuse isolated target/channel construction, with purpose-aware results

Extend `openRemoteHostTarget` and the existing session factory so callers declare `purpose: "management" | "workspace"`. Existing management callers retain their full Cognia transport result; requesting management on a tunnel returns typed `HOST_CAPABILITY_UNSUPPORTED`. A workspace lease exposes a bound `call` surface, effective operation descriptors and `release`; it does not claim arbitrary `Transport.subscribe` support.

Reuse [management-channel](../../lib/remote-host/management-channel.ts) reference counting rather than create another connection cache. Key lease entries by account + host ID + provider identity + credential epoch. Removal/sign-out/credential replacement closes stale leases immediately. Idle lease behavior is separate from explicit disconnect; periodic liveness must not keep an unused tunnel alive forever.

Keep the full-Host `activateHost` method restricted to `provider: "cognia"`. Add an explicit workspace-attachment action in existing host controls. Reuse the existing in-flight switch guard orchestration, extending its evidence to include scoped command jobs; do not invoke a Host switch merely to reuse its dialog. [Switch owner](../../hooks/devices/use-execution-host-switch.tsx)

### 3.3 Keep the SDK in the existing Node sidecar, behind native-owned handles

Place the SDK and MessagePack adapter in a new sidecar module justified by the new provider/protocol. Do not bundle Node SDK dependencies into the static-export renderer or add a standalone HTTP relay/service.

Extend the existing feature-call stdio request/result/abort infrastructure with a narrow remote-host operation family: discover/open/probe/call/close. The current Rust feature-call allowlist must be extended deliberately; arbitrary operations cannot pass today. Reuse existing supervisor epochs and shutdown. [Feature-call client](../../lib/claude/feature-call.ts), [native allowlist](../../crates/cognia-sidecar/src/commands.rs), [sidecar dispatcher](../../sidecar/src/host/feature-call/index.ts)

Use a dedicated, dependency-injected feature-call client whose call, abort **and event subscription** are pinned to the local native sidecar. Do not reuse the current `defaultClient`: its call is client-local, but its `claude://message` subscription follows global `RoutingTransport.subscribe`. With a full remote Cognia Host active, that combination sends locally and listens remotely. The provider's event source must remain local across full-Host switches; a remote event with the same request ID cannot settle its request. Existing `claude_feature_call/abort` dispositions are already client/internal and must retain that restriction.

Renderer requests contain host/binding IDs and an approved operation, not raw OAuth tokens, relay URLs, connection tokens, arbitrary protocol method names, or port numbers. Native/sidecar code resolves credentials and trusted endpoint metadata. Use the existing [sidecar-to-host RPC](../../sidecar/src/platform/host-rpc.ts) for scoped credential leases, bound to sidecar epoch + account + host + credential epoch. A general `secret_store_get` export is not part of this design.

The remote-host IPC entry is desktop-local; it cannot become reachable from the Companion device plane by adding it to a shared generic dispatcher. Validate its disposition, command ACL and host-RPC origin explicitly. Existing model feature calls remain unchanged.

### 3.4 Explicit workspace context prevents machine/path confusion

Introduce a small attachment context next to the existing remote-host target module:

```typescript
// Proposed contract, not implemented. Secrets and executable provider code are excluded.
type WorkspaceOperationContext = {
  accountId: string
  hostId: string
  attachmentId: string
  root: string
  generation: number
  credentialEpoch: number
}
```

The context is session-scoped and refers to the existing host record. It is not another host registry and does not reuse the application's [runtime-target context](../../lib/runtime/runtime-target-context.ts), which also selects Companion credentials and state scopes.

For the first delivery, do not insert arbitrary remote paths into persisted `Project.roots`, local allowed-root registration, local file watchers, knowledge indexing, or managed-worktree records. [WorkspaceRoot](../../types/workspace/index.ts) currently has no host identity. Reuse the workspace header/file-browser views with a bound remote context. Persist only host metadata; a reconnect/restart requires explicit attachment. Durable project attachments and cross-device propagation are a later schema change, gated on a host-qualified root model and legacy-client behavior.

Every tab, pending read, selection, dirty buffer, command job and cache uses `(accountId, hostId, attachmentId, root, generation)` as its scope. Two hosts with `/work/project` must never share content or command history by path alone. Switching invalidates late responses; it does not rewrite an in-flight request's target.

## 4. File reuse preserves the difference between raw remote access and confined workspace IO

The first delivery is a read-only remote browser for a trusted user-owned host. Its starting directory is a navigation choice, not a sandbox. User-visible copy must state that remote commands can access whatever the remote account can access.

| Existing surface / proposed capability                            | CLI mapping                                            | First-delivery contract                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Directory navigation / `raw-list`                                 | `fs_readdir`                                           | Real names/types; explicit raw listing, ignore rules not applied. Do not treat default `includeIgnored=false` as supported          |
| File information / `raw-stat`                                     | `fs_stat`                                              | Show reported existence/type/size; unavailable metadata is not proof of absence or lstat semantics                                  |
| Text/binary preview / `raw-read`                                  | `fs_read` duplex stream                                | Enable only after live read tests; bounded bytes, explicit truncation, known text encoding; no automatic ingestion into model/index |
| Confined `workspace.files`                                        | No equivalent verified                                 | Unavailable until realpath/lstat/root enforcement is implemented and adversarially tested                                           |
| Versioned read / CAS save                                         | Raw read/write is insufficient                         | Unavailable; no read-hash-then-write approximation                                                                                  |
| Recursive ignore-aware walk, search, watcher, chunk/random access | No equivalent verified                                 | Unavailable until exact semantics exist; manual refresh remains explicit                                                            |
| Create/write/rename/delete/copy                                   | Source methods exist; production guarantees unverified | Disabled in first delivery; later editing gate below                                                                                |

Factor bound callers inside [workspace-fs](../../lib/files/workspace-fs.ts) so the current default exports continue to behave identically for local/Companion users. Only callers supplying a context select the isolated provider lease. Capability checks occur before request dispatch. Do not expose a tunnel by changing only [hasWorkspaceFsBackend](../../lib/files/workspace-backend.ts), which is currently a boolean availability helper.

Preserve the existing presentational file-tree/preview modules. Extend metadata handling only where necessary: raw directory listings do not supply file sizes; show unknown/lazy metadata or fetch bounded metadata on demand, never manufacture size `0`, mtime, executable mode or a non-symlink verdict. The current [WorkspaceStat](../../lib/files/types.ts) documents lstat-style identity; raw target-following stat must carry a weaker descriptor rather than masquerade as that contract.

Reject NULs, invalid child names and lexical traversal in relative navigation; withhold recognized symlink entries from traversal until support is designed. These checks are useful but do **not** prove confinement: symlink ancestors and filesystem races remain possible. Never feed raw reads into an interface that requires realpath containment. Existing enforcement lives in [Rust files](../../crates/cognia-files/src/files.rs), not in the TypeScript wrapper.

Apply explicit preview allow/deny policy for credential-like names, require user action for raw preview, and keep file contents out of diagnostics. This policy is not a claim that the remote account is OS-confined. An Agent requesting strict workspace confinement is rejected.

Return a preview with `content`, `bytesRetained`, and `completion: "eof" | "limit-reached"`. Observe at most limit-plus-one bytes for truncation detection; decode text incrementally, retain at most the requested UTF-8 byte limit, and do not split a retained code point. A normal EOF within the bound is complete. On cap/oversize, close the dedicated operation control stream and settle locally as truncated; do not wait indefinitely for the discarded `fs_read` RPC result. This stops local consumption, not a proven remote IO cancellation. Tests must bound intermediate buffers as well as final strings.

### Editing gate

Before enabling normal editor save, choose and implement either a guarded remote helper or a full remote Cognia Host. The helper option is a separate deliverable with runtime detection, audited distribution and cleanup; it is not silently deployed during connection. It must implement no-follow/canonical-path policy, same-filesystem atomic replacement, compare-and-swap against expected raw bytes, create-if-absent, collision/error semantics, permissions, and bounded IO. A long-lived remote Cognia Host can instead provide those existing contracts directly. Neither is required for the first delivery.

Tests must extend existing conflict/save contracts, including [workspace-fs tests](../../lib/files/workspace-fs.test.ts) and [Rust file tests](../../crates/cognia-files/src/files.rs). A plain `fs_read` followed by `fs_write` cannot pass this gate because another writer can intervene.

## 5. Command reuse exposes completed results and uncertain outcomes honestly

Use the existing one-shot request validation, command classifier, approval UI, audit concepts and successful result rendering. Add a scoped exporter in [remote-api](../../lib/terminal/remote-api.ts) for providers with weaker termination guarantees; do not silently change `execTerminalCommand`'s kill-after timeout meaning.

The scoped executor returns one of:

| State             | Meaning / fields                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`       | Server exit result **and** stdout/stderr EOF observed; reuse `stdout`, `stderr`, `exitCode` from `RemoteExecResult`                                                                             |
| `not-started`     | Validation/approval/capability/version failure before sending `spawn`; safe to correct and retry explicitly                                                                                     |
| `outcome-unknown` | `spawn` may have been sent, but disconnect, wait deadline, cancellation or output bound prevented a verified final result; `exitCode: null`, `remoteMayStillRun: true`, reason and operation ID |

First-delivery `waitTimeoutMs` is a client wait budget, not `RemoteExecRequest.timeoutMs`'s confirmed kill-after promise. Defaults/limits below are proposed budgets. Do not set `timedOut=true` and imply the remote process stopped. Strict kill-on-timeout/sandbox/persistent-session/custom-PTY requests are unsupported before dispatch.

Mapping: direct executable + argv remains direct; explicit POSIX `shell:true` uses a detected/approved `/bin/sh -c` path with empty separate argv. Do not interpolate paths or user data into shell source. First-delivery compatibility is desktop clients to a tested Linux remote host; other remote OS/shell combinations remain unavailable until tested. Only explicit, approved remote env overrides are sent; no merge of local process env or local workspace secrets.

`spawn` opens three streams. Close unused stdin, drain stdout and stderr concurrently with independent byte accounting, and settle success only after final result and output EOF. A nonzero exit is a completed command result, not a transport failure.

### Cancellation and unknown outcomes

Closing a stream or disposing an SDK client is not evidence of process termination. An already-sent command is never auto-replayed, including after SDK reconnect. Show its original host/directory, retained output and “remote result unknown; may still run.” Disconnect, root change, removal and sign-out fence local results immediately; they do not claim to kill a remote process.

Before promising confirmed cancellation, add a remote supervisor with operation IDs, child/process-group ownership, bounded timeout/output, kill-and-wait acknowledgement and status reconciliation, or use a full Cognia Host. This is a later acceptance gate, not an assumed property of `sys_kill` or `spawn`.

### Desktop and Agent paths require explicit target routing

`runHeadlessExec` currently selects native `terminal_headless_run/exec` on Tauri even when a remote transport is selected. Its scoped extension must resolve the captured target **before** the native branch; a remote target cannot use raw local `invoke` as fallback. Existing [headless tests](../../lib/terminal/headless-exec.test.ts) must prove local APIs are never reached for remote requests.

First delivery does not enable unattended execution or advertise generic remote Agent tools. Sidecar built-in [read](../../sidecar/src/tools/builtin/core-files/read.ts), [write](../../sidecar/src/tools/builtin/core-files/write.ts), [edit](../../sidecar/src/tools/builtin/core-files/edit.ts), [patch](../../sidecar/src/tools/builtin/core-files/apply-patch.ts) and [bash](../../sidecar/src/tools/builtin/core-files/bash.ts) currently use local filesystem/process APIs. Only a later, audited target-aware tool path may expose remote IO. Do not make a local Agent believe its `cwd` is a remote local pathname. All future file/command output sent to a model must pass [assertModelSafeToolOutput](../../sidecar/src/policy/pii/tool-output.ts); SDK traffic itself is not a bypass around that gate.

## 6. Authentication has a verified development path and a separate product gate

The probe verified existing GitHub CLI authentication for one account, not automatic reuse of VS Code's profile/login database and not acceptance of a new Cognia OAuth application.

For a development preview, offer an **explicit** “Use existing GitHub CLI account” action: invoke the resolved `gh` executable directly, validate its numeric user identity, keep the token within the trusted host/sidecar processes, and obtain connect-scoped metadata. Do not silently inspect all accounts, write a second copy of a CLI-owned credential, log subprocess stdout, scrape VS Code SQLite/keychain records, or impersonate Microsoft's OAuth app. Absence/expiry requests reauthentication through the credential owner's normal flow.

For general product release, use Cognia-owned GitHub OAuth/device authorization only after its acceptance by the tunnel service and scope/refresh behavior have been verified. Reuse the existing secure-storage primitive and account/provider credential references. The decision is release-blocking for a GUI-only product, but does not invalidate an explicitly labeled CLI-auth development preview.

| Secret / identity                               | Owner / storage                                                   | Lifecycle                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GitHub account ID + credential source reference | Native secure owner; only public reference in registry            | Bound to Cognia account scope; account switch increments epoch                                           |
| CLI-owned OAuth token                           | CLI owns persistent copy; temporary native/sidecar memory lease   | No export, renderer delivery, or duplicate persistence                                                   |
| Future Cognia-owned OAuth credential            | Existing OS keyring/encrypted storage, typed provider payload     | Explicit sign-out/revoke; share references intentionally, do not delete another host's shared credential |
| Tunnel `connect` token and relay metadata       | Session manager memory only                                       | Expiry/refresh through owner identity; clear on close, credential change, sidecar death                  |
| Local approval/grant                            | Trusted host, bound to attachment + operation digest + generation | One command; not a forged remote Cognia `adminLease`                                                     |

Token acquisition is authorization; it is not consent to execute every command. Native IPC validates host/account binding and the one-use command approval before invoking the provider. Restrict upstream destination/endpoint schemes to SDK management metadata, retain SDK host-key verification, and disable automatic local forwarded-port listeners. Do not expose generic `net_connect`, arbitrary upstream ports, `spawn_cli`, or arbitrary MessagePack methods through renderer IPC.

## 7. Session state and deadlines are explicit and bounded

The session factory owns `disconnected -> authenticating -> discovering -> connecting -> probing -> ready`; errors settle as `reauth-required`, `unreachable`, `incompatible`, or `degraded`. Explicit disconnect/removal increments the epoch before asynchronous cleanup. Provider detail is runtime evidence alongside the existing connection state, not a persisted “ready” claim.

| Transition       | Owner / side effect                                                                      | Recovery                                                                |
| ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Connect          | Acquire credential lease; resolve exact saved identity; establish relay; receive version | No workspace operations before supported protocol and operation checks  |
| Attach root      | Bind account/host/attachment/generation; stat root; require trusted-host disclosure      | Failure keeps root unattached, never opens matching local path          |
| Switch root/host | Run shared guard with pending command evidence; fence old generation                     | Keep original jobs attributed; unknown jobs do not silently disappear   |
| Auth expiry      | Stop new requests; refresh via credential owner                                          | Resume new reads after fresh probe; no spawn replay                     |
| Connection loss  | Invalidate capabilities; abort bounded read waiters; mark sent commands unknown          | Explicit reconnect; distinguish observation from repeat execution       |
| Sidecar crash    | Native supervisor epoch invalidates all session/approval handles                         | Reopen explicitly; no automatic reconnection-to-execution chain         |
| Remove/sign-out  | Close leases and clear tokens before final UI removal                                    | Host deletion does not revoke shared OAuth grants or delete remote data |

Proposed initial resource budgets, not measured SLOs:

| Resource                       | Budget / failure behavior                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery / connect / greeting | 15s / 30s / 10s per stage, cancellation supported; fail with stage code                                                                      |
| Concurrent sessions            | At most 4 attached hosts per desktop; at most 4 control streams per host, including 1 command stream                                         |
| Directory / protocol frame     | 2,000 entries as a client rejection cap; 2 MiB decoded frame/aggregate envelope limit; reject oversize without presenting a complete listing |
| Preview                        | 256 KiB default, 1 MiB hard limit; explicit truncated preview; model ingestion unavailable                                                   |
| Command                        | 120s wait default, 600s max wait; 64 KiB each stdout/stderr; on exceeded bound return unknown and dispose operation stream                   |
| Lease idle                     | Reuse existing 150s idle lease; no tunnel background keepalive probes while unreferenced                                                     |
| Retained diagnostics           | Existing local diagnostic/audit retention; no new content/token log; operation IDs have bounded lifetime                                     |

Use SDK streams without listening sockets. Share one relay session per keyed host lease and use bounded operation control streams so a preview decode failure cannot corrupt another command's MessagePack decoder. The per-operation stream owns request IDs, EOF state and deadlines. Backpressure and disposal are integration-test requirements. Transport handshake deadlines must not truncate a deliberately longer command wait through the existing generic 30-second RPC default.

`fs_readdir` returns an entire array and has no verified pagination or server-side entry bound. The directory budget is therefore an admission/rejection limit on the client, not a claim that the remote server only enumerates 2,000 entries. Enforce array/map/string/bin limits during incremental decoding before trusting lengths or allocating the full object. On overflow, dispose that operation stream, report `REMOTE_RESULT_TOO_LARGE`, and suggest a narrower directory; do not fabricate pagination or label a truncated result complete.

## 8. Reuse existing UI and show only delivered capabilities

Extend the existing Devices add-host flow with a provider choice and a tunnel discovery list. Rows display provider, account, friendly label, last verified status/time, supported operations and failure remedy. Do not replace manual selection with background account-wide execution probes.

The actions are “Connect workspace”, “Browse directory”, “Run command”, “Disconnect” and existing rename/remove. The root and command panel continuously identify the remote host; the full application Host indicator continues to identify the Cognia Host that owns app state. A workspace attachment cannot silently disable local bots or move scheduled work.

Adapt [device section planning](../../lib/devices/section-plan.ts) and [device runtime projection](../../lib/devices/device-runtime.ts) to provider/capability evidence. Tunnel rows do not receive always-on, secrets, Host update, system management, sandbox, scheduler-placement or remote-desktop controls merely because their row kind is `remote-host`.

Filter the global [ExecutionHostSwitcher](../../components/devices/execution-host-switcher.tsx), settings activation lists and connect-after-pairing actions to `provider: "cognia"`. That switcher currently enumerates all stored hosts, reads `config.baseUrl`, and invokes full Host activation. A tunnel appears in Devices and the workspace attachment flow, not as a selectable full Host.

[Devices files section](../../components/devices/sections/files-section.tsx) currently opens SSH/SFTP profiles. Retain that branch; add an explicit provider-bound file-browser branch, reusing presentation and previews without passing a tunnel ID to the SSH launcher.

The reusable [ProjectFileTree](../../components/editor/project/project-file-tree.tsx) already accepts IO dependencies, but requires mutation handlers and has no complete read-only action contract. Add action capabilities covering menus, keyboard shortcuts, clipboard paste, drag/drop, create, rename, delete and save; hide/disable mutation actions and provide typed refusal handlers as a second defense. Add an explicit attachment `scopeKey` and refresh policy. Reset/remount when host, attachment or generation changes, and use manual refresh in the first delivery: current global-transport subscriptions/polling must not govern an independent scoped tree.

The existing [FilePreviewSurface](../../components/file-viewer/file-preview-surface.tsx) otherwise falls back to a global `loadWorkspaceText` call. Supply already bounded provider content through its `providedText` path, with no fallback to a global/local loader. Extend [FileViewerRequest](../../lib/file-viewer/types.ts) with an untrusted remote source and an explicit viewer policy. Remote HTML/SVG/script-like content is displayed as text in the first delivery; it must never acquire the `project-preview` script permission. Binary content remains metadata/download-unavailable until a bounded, inert supplied-bytes renderer is separately verified.

Loading, no authenticated account, no matching tunnel, offline, expired identity, unsupported protocol, inaccessible directory, unknown command outcome, and disconnect are distinct UI states. Reuse existing error/empty/approval controls. All labels, hints, errors and aria strings belong in both split locale sources; generate aggregates. Keyboard/focus return after approval and screen-reader announcement of final/unknown state are required. No new Next.js server route is needed.

## 9. Data migration preserves existing pairings and remains reversible

The current `cognia-remote-hosts` Zustand persistence version is `3`. Its pre-v3 purge is a historical credential migration, not a template for the next version. Implement an explicit v3-to-v4 migration that retains all existing IDs, labels, public config and credential references and marks them `provider: "cognia"`; reuse old pre-v3 behavior only for those historical inputs. Unknown provider rows are retained but unavailable, never interpreted as Cognia.

No Dexie schema migration is required for first-delivery attachments because they are session-scoped; do not persist remote roots in Project/Dexie or portable sync. Existing registry data is device-local and must be filtered by account ownership. Legacy Cognia rows without account ownership keep their existing visibility/behavior; do not assign them to the currently logged-in user during migration. Newly created tunnel records always have explicit ownership.

Before enabling provider records, update all store hydration, factory, deduplication, liveness, deletion, export and UI paths to branch on provider. The old eager `hydrateHostCredential` loop must not parse a tunnel credential as a device JWK. Export/import contains only public metadata; importing a tunnel never authorizes or reconnects it.

Rollback uses a disabled-by-default local feature flag plus additive record compatibility. Before a controlled binary downgrade, generate a sanitized v3-compatible projection from the **current v4 document**, containing only Cognia records; it must contain no secret material. Do not restore the initial migration snapshot after subsequent add/re-pair/remove operations, and do not roll back shared credential storage. Downgrading to a binary that cannot parse v4 requires explicit projection restore before launch, because the old code is not provider-aware. Preserve the current v4 metadata for forward recovery. Disabling the feature on the new binary does not require schema downgrade or delete records, credentials or user work. Test failed migration writes, mixed providers, repeated migration, and Cognia add/re-pair/remove followed by projection restore. No published-history rewrite or automatic credential revocation is involved.

## 10. Alternatives were compared against reuse and contract correctness

| Option                                                   | Benefit                                                                                 | Cost / reason for recommendation                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Same registry + isolated workspace attachment**        | Reuses host identity, UI, leases and file/command owners while preserving app ownership | Recommended; explicit context threading and partial-capability handling are necessary                                          |
| Install tunnel as global active `Transport`              | Appears to reuse every call site                                                        | Rejected for first delivery: triggers app-state/scheduler/connector behavior and false full-Host capabilities                  |
| Create a separate tunnel registry/browser/executor stack | Locally simple prototype                                                                | Rejected: duplicate identity, credentials, removal, status and future routing policy                                           |
| Install Remote - Tunnels into extension shim             | Reuses official extension package                                                       | Missing resolver/workbench contract; does not solve native Cognia file/exec integration                                        |
| Embed official `vscode.dev`                              | Fast manual remote editing candidate                                                    | Useful independent UI route; does not provide native Cognia IO/Agent contracts                                                 |
| Require remote Cognia Host now                           | Reuses existing complete confinement/admin/task contracts                               | Valid for full trusted Host behavior; adds remote deployment the current tunnel-only attachment does not require               |
| Implement the Rust SDK now                               | Direct native integration                                                               | Current Git pin/dependency/lifecycle work exceeds the already validated TS route; reconsider after adapter contract stabilizes |

The trusted first-delivery scope is a deliberate product boundary, not a permanent replacement for full workspace IO. If editing or unattended automation is required in the first public release, the guarded-helper/full-Host gate moves into that release's critical path.

## 11. Acceptance maps directly to goals and includes negative routing evidence

| ID / goal                     | Given / when / then                                                                                                                                                                                                                                                                      | Owning verification                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A1 Reuse host registry        | Existing v3 Cognia records plus a new tunnel are migrated; all old pairings still work and no second host list exists                                                                                                                                                                    | Store + credential + factory co-located tests                |
| A2 Scope isolation            | Attach a tunnel while local or a full remote Cognia Host owns app state; connectors, bots, session mirror and scheduler target remain unchanged; local sidecar replies still arrive, remote same-ID events cannot settle them, and tunnel rows cannot invoke the full Host switcher      | Host-target / local event / lifecycle integration tests      |
| A3 Real connectivity          | With explicit development credentials, discover only selected tunnel identity, obtain connect metadata, handshake supported protocol and list a disposable root                                                                                                                          | Opt-in real-tunnel test; protocol fixture tests              |
| A4 Read-only files            | List/stat and bounded text preview work; traversal/known symlink/credential-name cases follow stated policy; oversize arrays reject without allocating the whole payload; all mutation/keyboard/drag paths are disabled, remote content never uses global loaders or active HTML viewers | Bound facade + file view tests; live `fs_read` test          |
| A5 Explicit commands          | Approved command uses the selected host/cwd, captures both outputs and final EOF; nonzero exit remains completed                                                                                                                                                                         | Executor tests + disposable live command                     |
| A6 No wrong-machine execution | Switch/disconnect/remove during every await, including identical paths on different hosts; tree/preview caches reset by scope key; all local `invoke`, local filesystem and alternate-pairing fallbacks are spied and never called                                                       | Headless/file/target integration tests                       |
| A7 Honest uncertainty         | Drop connection or exceed wait/output limits after sending spawn; outcome is unknown, not killed/succeeded; reconnect never replays it                                                                                                                                                   | Fake protocol peer + stream lifecycle tests                  |
| A8 Credential ownership       | Wrong account, credential replacement, token expiry, stale sidecar epoch and host replacement reject; logs/export contain no secret                                                                                                                                                      | Native broker + provider tests; secret-pattern artifact scan |
| A9 Lifecycle                  | Close last lease, remove host, sign out, crash sidecar or quit app; streams/timers settle and no child/socket/task keeps tests alive                                                                                                                                                     | Supervisor and deterministic disposal tests                  |
| A10 Compatibility             | Current local/Companion filesystem, command policy, full Host activation and SSH/SFTP flows retain behavior                                                                                                                                                                              | Existing targeted regression suites                          |

Use a local fake relay/control peer for arbitrary MessagePack fragmentation/coalescing, duplicate IDs, malformed/oversized frames, late/out-of-order stream EOF, auth errors, unsupported versions and output bounds. Do not require real GitHub credentials in CI. Real tests are opt-in and use an owned disposable directory with separate approval for mutation/termination tests.

Implementation checks must use then-current package scripts. Existing targeted anchors include `stores/remote-host/remote-host-store.test.ts`, `lib/remote-host/{target-transport,management-channel,liveness,credential-vault}.test.ts`, `lib/terminal/{remote-api,headless-exec}.test.ts`, `lib/files/workspace-fs.test.ts`, and `lib/devices/{section-plan,device-runtime}.test.ts`; new provider modules require co-located tests. Native changes require focused Rust tests, registration/ACL checks and real Tauri smoke. Sidecar outbound tool changes require PII and wiring review before Agent support.

Expected future gates include `rtk pnpm exec jest --runInBand --runTestsByPath <owned tests>`, `rtk pnpm run sidecar:test`, `rtk pnpm run sidecar:typecheck`, `rtk pnpm run typecheck`, scoped ESLint, `rtk pnpm run i18n:build`, `rtk pnpm run i18n:build:check`, `rtk pnpm run lint:i18n`, `rtk pnpm run lint:static-export`, production build and focused Tauri/browser E2E as applicable. Do **not** run coverage or impose a coverage threshold unless requested. These are planned checks, not results of this proposal-only task.

## 12. Observability reports provider health without exporting user content

Reuse the existing operation-performance and diagnostic/audit owners. Record stages `discover`, `token`, `relay`, `greeting`, `capability`, `read`, `exec`, `close`; outcomes `ok`, `denied`, `unsupported`, `disconnected`, `unknown`, `timeout`, `oversize`. Metric dimensions are provider, stage, protocol generation and bounded error code; host/account/path/request IDs belong only in access-controlled local diagnostics, never metric labels.

Audit command approval, dispatch and outcome with an opaque operation ID, host/attachment reference and source. Reuse existing command-audit redaction rules; do not introduce raw command, env, file-content, OAuth-header, relay-query or connect-token dumps. Debug logging must redact before formatting exception/config objects.

Proposed rollout gates: any wrong-machine request, leaked credential, replayed command or falsely confirmed termination aborts rollout immediately. In a controlled canary, more than 2 failed opens in 20 attempts after credentials/network were independently verified pauses expansion; this is a release gate, not an established production SLO. Operators disable the feature, preserve unknown command records, and ask users to reconcile remote processes before retrying.

SDK/service traffic and limits depend on Microsoft. No new Cognia cloud service, model request or storage service is proposed. Added package/disk/startup cost must be measured in P2; use lazy loading so ordinary startup does not import or authenticate the SDK. Do not extrapolate a latency SLO from one successful probe.

## 13. Delivery phases have independent owners, verification and rollback

| Phase                                                              | Single owning role / dependencies                    | Deliverable                                                                                                              | Exit / rollback                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Review and contract fixtures                                    | Architecture owner; this proposal                    | Resolve Q1–Q4; pin upstream protocol/SDK fixtures and acceptance list                                                    | Approval only; no feature implementation in the current task                                                                              |
| P1 Provider identity and scoped sessions                           | Remote-host owner; P0                                | Provider union, v3→v4 preservation, shared factory/leases, purpose-aware access and capability-gated Devices rows        | A1/A2/A8/A9; flag off and restore compatible registry projection                                                                          |
| P2 Trusted SDK transport and auth preview                          | Native/sidecar owner; P1                             | Local-only IPC, credential-source action, connect/probe/read streams, protocol resource bounds, disposal                 | A3/A8/A9 and real greeting/list/read; disable provider without altering global Host                                                       |
| P3 Read-only browser and approved commands                         | Files/terminal owner; P2                             | Context-bound facade/view reuse, remote outcome model, in-flight target guards, negative local-routing tests             | A4–A7/A10; close attachment and retain unknown-job evidence                                                                               |
| P4 Editing / guaranteed termination, separately approved           | Files/terminal owner; P3 and helper-vs-Host decision | Real confinement/CAS/atomic-write semantics and supervised process lifecycle                                             | Full adversarial write/kill tests; remain read-only/wait-only on failure                                                                  |
| P5 Agent/Workflow and durable project binding, separately approved | Agent runtime owner; P4                              | Host-qualified durable roots, local-tool bypass audit, PII-safe tools, explicit workflow target and capability admission | No native fs/spawn fallbacks; strict isolation requirements still reject unsupported provider; disable new tool path without losing files |

Documentation, i18n, migration, diagnostics, tests and shutdown behavior are included in each owning phase. P4/P5 are explicit additional scope, not unfinished first-delivery code. No unimplemented feature is advertised to satisfy a phase gate.

### Expected implementation owners / file groups

| Group             | Existing files to extend                                                                                                                                                                                                                                         | New files justified by missing implementation                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/session  | `stores/remote-host/remote-host-store.ts`; `lib/remote-host/{target-transport,management-channel,liveness,credential-vault}.ts`                                                                                                                                  | A small provider contract/adapter module next to existing remote-host targets; no second registry                                                     |
| Workspace context | `lib/files/{workspace-fs,workspace-backend,types}.ts`; `lib/terminal/{remote-api,headless-exec}.ts`                                                                                                                                                              | `lib/remote-host/workspace-target.ts` for scoped context/lifecycle; existing runtime-target module has a different ownership contract                 |
| Trusted bridge    | `lib/claude/feature-call.ts`; `crates/cognia-sidecar/src/commands.rs`; `sidecar/src/host/feature-call/index.ts`; owning wire types                                                                                                                               | Provider module under `sidecar/src/remote-host/` for SDK + private CLI protocol; native scoped credential broker under existing sidecar/secret owners |
| UI                | Existing Devices add-host/host-controls/files sections and full Host switcher filtering; `ProjectFileTree` capabilities/scope/refresh; `FilePreviewSurface` supplied content and viewer source policy; workspace context and command result views; split locales | New provider-specific discovery panel only if current add-host surface cannot hold its flow; no separate file explorer application                    |

All path additions above are proposals. No source module, route, schema, native command, dependency or locale is changed by this document.

## 14. Reviewer decisions and follow-up ownership

| Decision                        | Options / recommendation                                                                                                                           | Consequence                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Q1 Attachment scope             | **Recommend:** existing registry + workspace-scoped session; alternative global full-Host activation                                               | Global activation would require a larger app-ownership redesign before any tunnel can be selected    |
| Q2 First deliverable            | **Recommend:** trusted-host read-only browsing + explicit unconfined command approval; alternative require editing/strict cancellation immediately | Alternative makes P4 guarantees and helper/full-Host choice mandatory before first release           |
| Q3 Authentication release       | **Recommend:** explicit GitHub CLI credential-source preview, then independently validated Cognia OAuth for GUI-only release                       | No implicit VS Code credential extraction; dedicated OAuth acceptance remains a product-release gate |
| Q4 Editing/termination provider | **Recommend:** keep raw tunnel scope separate; assess guarded helper versus an optional full Cognia Host before P4                                 | No claim of CAS, OS confinement or confirmed termination from raw CLI RPC alone                      |

Suggested review deadline is **2026-10-23**, a planning proposal rather than a user commitment or implementation start date. The owner roles below must accept and replace it if another release schedule is chosen.

| Follow-up                                   | One owner               | Proposed ISO DDL | Completion evidence                                          |
| ------------------------------------------- | ----------------------- | ---------------- | ------------------------------------------------------------ |
| Resolve Q1/Q2 and first-release acceptance  | Architecture reviewer   | 2026-10-23       | Recorded decision; no hidden expansion to full Host behavior |
| Resolve Q3 and allowed credential ownership | Security reviewer       | 2026-10-23       | OAuth/CLI-preview decision and account-scope test plan       |
| Resolve Q4 before scheduling P4             | Files/terminal reviewer | 2026-10-23       | Helper-vs-Host decision or explicit continued deferral       |

| Review record                                | Status                      | Evidence                                                                                                                                         |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current host/routing ownership audit         | Completed, read-only        | Store/target/channel and app-ownership consumers inspected                                                                                       |
| Current file/exec/Agent contract audit       | Completed, read-only        | Confinement/CAS/cancellation and local bypasses traced                                                                                           |
| Existing live SDK experiment                 | Passed before this proposal | [SDK validation follow-up](../research/2026-10-18-dev-tunnels-sdk.md#live-validation-follow-up--2026-10-18)                                      |
| Proposal source/link/structural review       | Completed                   | Two scoped architecture reviews; Prettier check; 54 local links/anchors; acceptance/phase/secret checks passed. No implementation tests were run |
| Human product/security/architecture approval | Pending                     | Q1–Q4; no approval or implementation inferred                                                                                                    |

## 15. Evidence index and protocol source pins

- [Initial feasibility research](../research/2026-10-18-vscode-remote-tunnels-feasibility.md) and [SDK audit / recorded live experiment](../research/2026-10-18-dev-tunnels-sdk.md). Local private account/tunnel/workspace identifiers are intentionally omitted from this proposal.
- [Microsoft Dev Tunnels source pin](https://github.com/microsoft/dev-tunnels/tree/b73b0eb774b86a5b519c300f2f41c9072a66f663): SDK transport and token-refresh contracts. TypeScript package `1.3.61` declarations were also inspected in the earlier audit.
- [VS Code CLI source pin](https://github.com/microsoft/vscode/tree/789f2c470d13c4760f2b5cc6a9e1919c05d04f7d/cli): discovery, MessagePack framing and filesystem/process operations. Source visibility is not a stable public protocol promise; the live protocol-6 test supplies separate compatibility evidence.
- [CLI control handlers](https://github.com/microsoft/vscode/blob/789f2c470d13c4760f2b5cc6a9e1919c05d04f7d/cli/src/tunnels/control_server.rs), [protocol payloads](https://github.com/microsoft/vscode/blob/789f2c470d13c4760f2b5cc6a9e1919c05d04f7d/cli/src/tunnels/protocol.rs), and [MessagePack framing](https://github.com/microsoft/vscode/blob/789f2c470d13c4760f2b5cc6a9e1919c05d04f7d/cli/src/msgpack_rpc.rs).
- [Server product/source distinction](../research/2026-10-18-vscode-remote-tunnels-feasibility.md#relevant-distribution-boundary): this design does not redistribute the official Server or extension; any later distribution change needs its own artifact-specific review.

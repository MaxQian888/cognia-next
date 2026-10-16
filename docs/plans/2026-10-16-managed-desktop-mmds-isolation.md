# Managed desktop MMDS isolation: proposed ADR-0228 amendment

Date: 2026-10-16. Status: **accepted by the user on 2026-10-16; P0 primitives verified; exact guard verification pending**.
Author/owner: managed-desktop workstream. Review: runtime/security and delivery owners.
Baseline: `6c97c9dc7d09500753b4b60acfcc97fdd9af2073`, detached integration worktree.
Scope: guest image, Linux workload confinement, Host qualification and handoff.
The approved wording is now recorded in both ADR-0228 locales. Production remains dormant; implementation starts with the P0 capability gate.

## Recommendation: isolate the complete workload in an offline network namespace

Keep E2B's provider egress-Off policy and add a mandatory guest-kernel boundary:
the desktop, terminal/browser descendants, source import/Git, acceptance scripts
and probes have no external network interface or route. Keep only loopback for
the task's local preview. Provider envd remains outside that workload boundary.
Bridge GUI ingress through a fixed local Unix socket, never a general network
proxy. Reuse Cognia's Linux namespace/launcher policy rather than invent another
provider lifecycle. Namespace failure must prevent workload startup.

This requires approval of a precise ADR distinction: workload metadata denial
versus trusted provider initialization that still uses sandbox-local MMDS. It
does **not** qualify the current image, waive metadata denial for any workload,
or reinterpret the previous failed root probe as success. If the requirement is
instead that every process in the entire VM, including envd, must be unable to
contact this address, the current hosted E2B integration remains blocked.

Approval is requested for this design and its staged verification, not for a
claim that the provider supports it already. E2B kernel/namespace compatibility
is an explicit first implementation gate.

## 1. Confirmed evidence separates the workload from provider initialization

| Evidence                                                                                                                | Status and consequence                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest native probe returned an HTTP response only for `169.254.169.254:80`; all other nine fixed targets returned none | Confirmed by the [smoke record](2026-10-16-managed-cloud-desktop-real-provider-smoke.md). No response bodies or metadata tokens were read. All resources were cleaned up; no qualification was installed. |
| E2B envd pins an MMDS route and uses the address for initialization                                                     | Confirmed in upstream source pinned to `a1899fb840e1eb1ef2c0ffc751c639959ed6a144` [S1, S2]. This does not prove the exact deployed runtime revision or identify the previous HTTP response.               |
| An explicit provider `/32` deny is sufficient to block MMDS                                                             | **Not established**. Upstream issue #3625 reports the contrary; the linked clarification PR remains open [S3]. It is not an accepted provider conformance guarantee.                                      |
| Namespace-only-loopback can remove the workload's route to MMDS                                                         | Supported by Linux namespace semantics [S4]; **not yet verified inside this E2B template**.                                                                                                               |
| Existing Docker deployment hardening applies to E2B                                                                     | False assumption: container capability/mount flags in the image README are not automatically VM process restrictions.                                                                                     |

Current entrypoints are independently reachable:

| Entry         | Current implementation                                                                     | Required change after approval                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop       | `envd.rs::start_desktop_at` → image `entrypoint.sh` → `gosu cua` → `startup.py`            | Establish confinement before Xvfb, D-Bus, Openbox, xterm, Chromium or computer-server starts.                                            |
| Handoff       | `handoff.rs::install_on_desktop` → root `handoff_guest.py` → Git; npm alone drops to `cua` | Move source parsing/Git into confinement and out of root authority. Launch preview/npm under the desktop's complete confinement profile. |
| Qualification | `envd.rs::probe_desktop_egress_at` launches root Python directly                           | Keep that observation separately; add workload-origin evidence from the actual launch boundaries.                                        |

`PR_SET_DUMPABLE=0` currently protects credentials but does not establish network
isolation or `no_new_privs`. Chromium currently starts with `--no-sandbox`; the
outer workload boundary therefore assumes browser/application code may be
hostile. Browser settings and application cooperation cannot be the boundary.

## 2. Alternatives and their rejection conditions

| Option                                                                   | Advantage                                                                                                | Limit / decision                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-wide MMDS deny preserving envd                                  | Smallest Cognia change if supported                                                                      | No verified hosted control currently provides it. Keep as a future alternative; do not retry identical denyOut settings as proof.                                                                                                                                                  |
| Guest OUTPUT firewall keyed by UID/cgroup                                | Smaller ingress change; can preserve envd                                                                | UID rules alone miss root Git/parser paths, inherited sockets and privileged local proxies. Requires rules in the correct hook, protected membership, capability removal and tamper recovery. No reusable guest firewall manager exists here. Not the primary recommendation. [S5] |
| Loopback-only workload network namespace                                 | Denies direct IPv4/IPv6 egress without per-address rules or DNS assumptions; preserves local app preview | Requires a fixed ingress bridge and all launch paths inside the boundary. **Recommended for the already-Off-only release.**                                                                                                                                                        |
| HTTP proxy/browser policy                                                | Reuses destination checks                                                                                | Raw sockets and non-cooperating programs bypass it. Reject as an isolation boundary.                                                                                                                                                                                               |
| Seccomp alone                                                            | Reduces escape surface                                                                                   | Classic filters cannot inspect pointed-to socket-address contents. Retain as additional hardening, not the destination firewall. [S6]                                                                                                                                              |
| Accept MMDS response, drop metadata probe, or exclude source-import path | Easiest way to turn the existing smoke green                                                             | Violates the requested workload invariant. Rejected.                                                                                                                                                                                                                               |

A global metadata DROP rule could break envd initialization/re-initialization;
an OUTPUT rule scoped to a workload is not automatically defeated by envd's NAT
RETURN rule. The reason to prefer a namespace is the simpler no-route invariant
and coverage of every workload socket, not a claim that all guest firewall
approaches are impossible.

## 3. Workload and control channels have distinct privileges

The following is a proposed flow, not an implemented deployment:

```text
Host lifecycle/lease/handoff service
  | authenticated E2B ingress and envd commands
  v
VM control boundary: provider envd + fixed Cognia supervisor
  |-- envd initialization --> provider-local MMDS (explicit trusted scope)
  |-- port 8000 relay --> one preselected Unix socket --> computer-server
  |-- opaque bounded delivery bytes --> confined importer
  |-- fixed launch request --> confined desktop/acceptance process
  v
Workload boundary: isolated net/PID/mount/IPC namespaces
  computer-server, X11, session D-Bus, browser, terminals, application children
  local app preview <--> loopback only
  no NIC, veth, gateway, default route, DNS proxy or provider-network socket
```

### Mandatory launch profile

1. E2B envd initializes first. Only immutable image/bootstrap code may run before
   confinement; no delivery data, package scripts or user-selected commands are
   executed in that interval. Template readiness verifies the installed guard;
   runtime readiness verifies the actual established boundary.
2. A fixed supervisor creates the desktop's namespaces before opening GUI
   admission. Network scope contains only loopback, with no veth, TAP, bridge,
   forwarding, NAT or connection to the VM's default namespace. IPv6 either has
   only loopback or is disabled in this namespace; it must not inherit a route.
3. Before executing any workload, drop supplementary groups and all capability
   sets, select the unprivileged workload UID/GID, set `no_new_privs`, and close
   inherited descriptors except an explicit minimal whitelist of local data/GUI
   descriptors. No outside-network, namespace or privileged control descriptor
   may survive. Install the mandatory desktop hardening profile. Setup privileges
   never survive into project code.
4. Mount a minimal read-only runtime and image code, private `/proc`, `/dev`,
   `/tmp` and runtime directory, and only the selected writable workspace/home.
   Do not expose provider `/run/e2b`, root state, outer `/proc`, namespace handles,
   system D-Bus, Docker sockets or general helper IPC. Session D-Bus/X11 live
   entirely inside the workload boundary.
5. Prevent returning to an ancestor namespace, changing routes/capabilities,
   obtaining privileged descriptors or invoking a privileged execution helper.
   Reuse existing seccomp rules after namespace setup. The desktop profile must
   fail if its required filter cannot be installed; the existing optional
   best-effort behavior for other execution backends must not be changed.
   Thread/process creation remains supported; namespace-creation flags and
   `clone3` need explicit compatible handling rather than a blanket clone ban.

`no_new_privs` is necessary but does not remove existing privileges or stop
descriptor passing [S7]. Inherited socket and IPC restrictions are independently
required. Kernel/provider/Host-admin compromise remains outside the threat
model, as in ADR-0228's existing provider trust boundary. The trusted supervisor
and relay also live outside the workload network namespace; this proposal does
not claim that only envd can physically reach MMDS. They must remain immutable,
fixed-function control-plane code with no project parsing, arbitrary destination
or unconfined execution path available to workloads.

### GUI ingress is a fixed destination, not a route out

The external port and existing computer-server HTTP/WebSocket protocol remain
the same. A small relay accepts port 8000 and forwards bytes only to one
supervisor-created AF_UNIX listening socket. Uvicorn supports Unix sockets and
pre-opened listener descriptors [S8]; the recipe must pin and test the actual
installed version. The server keeps its current guest-token and Origin checks.

Create the socket in a supervisor-owned directory unavailable to workloads;
pass only its listening descriptor into the server and close it in unrelated
children. The relay uses a separate unprivileged identity after setup. It has
no provider key, envd token, command API, configurable upstream, CONNECT/SOCKS
mode or SCM_RIGHTS handling. It cannot accept a destination from HTTP headers,
query parameters or guest output. Cap active streams and buffer sizes and use
backpressure; relay loss closes ingress and fails the session rather than
falling back to a direct VM-network listener. Existing dual authentication and
WebSocket-frame checks must pass through this bridge.

### Handoff cannot retain a privileged source parser

Extend the existing framed transfer and guest installer. Keep source delivery
binding, read-only Host Git export, size/hash/deadline checks and cleanup rules.
The privileged supervisor may allocate protected staging, copy/hash bounded
bytes using pre-opened no-follow descriptors, and persist control receipts. It
must not run Git, extract project archives or execute project-controlled code.

Run Git verification/fetch/checkout and acceptance-file handling as a separate
unprivileged importer identity under the same strict network policy. An importer
may use a separate equally isolated namespace; it does not need desktop
loopback access. Keep staging inaccessible to desktop UID until the importer
and all its descendants exit. Treat importer output and its filesystem as
hostile. After proving the entire importer process tree has stopped, promote
files using descriptor-relative, no-follow operations; reject symlinks, hardlinks
and special files. Derive protected receipt identities and manifest/commit
bindings from the authenticated Host request, never importer-provided paths or
receipt fields. The workload cannot rewrite the protected receipt. Existing
path validation and uncertain-ack protections must survive this split.

Launch the requested npm/application process through the protected supervisor
under the **complete desktop confinement profile**, including its network,
PID/mount/IPC restrictions, unprivileged identity, capability/NNP state, mandatory
seccomp and descriptor sanitation before exec. Reuse the existing desktop
network namespace: a separate empty namespace for npm would break
browser-to-local-preview access. Select namespace handles by the supervisor's generation-bound registry,
never a workload-supplied PID/path. The existing Host lease/consent controls own
the operation; no guest-facing general root execution service is introduced.

## 4. Evidence must prove the real workload boundary

Keep the previous root/provider probe and its metadata response as historical
and diagnostic evidence. A new qualification version must not backfill or flip
that failure. Retain all existing lifecycle, provider policy, authentication,
decoded-frame and deletion-retry assertions, then add mandatory workload proof.

Proposed evidence fields, owned by native Host code (not renderer booleans):

| Field                       | Meaning                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `workloadIsolationRevision` | Versioned mandatory launch/profile contract, initially 1                                        |
| `enforcement`               | `provider-and-guest-kernel`; never the current misleading provider-only label                   |
| `boundaryGeneration`        | Host-bound session generation; namespace IDs alone are not identity                             |
| `launchPathsVerified`       | Desktop descendants, confined importer and acceptance launch all covered                        |
| `workloadEgressVerified`    | Every required workload target denied, including MMDS; old root probe remains separately scoped |
| `escapeResistanceVerified`  | Privilege, namespace, inherited-FD and local-helper attempts denied                             |

Do not trust `/cognia/health`, a guest-reported UID, or arbitrary script stdout
as sufficient attestation. The native operator verifies the immutable image,
reads supervisor-owned boundary state over authenticated envd, correlates the
generation/process/namespace identities, and performs fixed adversarial probes
through actual launch paths before project data is admitted. Sanitized health
is a compatibility signal, not a replacement for those observations.

Any workload TCP connection/HTTP response to metadata is failure, including
401/403 and responses resembling MMDS. Keep all ten existing target classes;
add direct-socket probes on representative TCP/UDP ports, IPv4-mapped IPv6,
UDP/QUIC, hostname/redirect attempts, and attempts to reach envd/local control
services. The all-port invariant comes from only-loopback interfaces, no external
routes and no inherited outside-network sockets, not an exhaustive port scan.
Lack of response alone is not proof: correlate with namespace interfaces/routes,
socket/FD inventory, capability/NNP state, and successful positive
local-preview/control checks. An intentionally weakened test profile must make
the harness fail.

Browser evidence uses actual navigation/network outcomes, not a CORS error.
Terminal and npm checks exercise the normal GUI/handoff entrypaths. Mandatory
direct transport probes run even if browser policy happens to block earlier.

## 5. Missing isolation means teardown, never fallback

The supervisor owns the namespace handles and process lifetime; untrusted
processes cannot change that registry. Setup is ordered and idempotent for an
exact desktop generation. A duplicate bootstrap returns the same verified
generation or refuses; it cannot attach to a stale PID or half-created socket.

Keep application admission closed until the boundary is verified. On missing
kernel support, namespace mismatch, incomplete privilege drop, relay failure,
probe anomaly or supervisor death: close ingress, revoke control, stop workload
children, and use the existing destroy/destroy-retry path. Provider TTL kill
remains the independent backstop. Host restart revalidates the live boundary
before reconnect/handoff; unverifiable state is destroyed, not repaired by
temporarily executing outside confinement. No pause or resume is introduced.

Supervisor-death cleanup requires an independent trusted lifetime guard or
namespace-init/parent-death mechanism: a dead supervisor cannot clean up itself.
Terminate all workload descendants and close ingress even while the Host is
disconnected. Fault-inject supervisor SIGKILL with the Host disconnected to
verify this behavior. Host journal reconciliation and provider TTL are additional
independent backstops, not substitutes for guest lifetime enforcement.

The published image/recipe revision changes from 3 to 4 only after the complete
implementation is built. Existing `binding_digest()` already includes the
release/config; reuse it for exact-template qualification invalidation. Add
explicit evidence-version validation so missing/old records cannot satisfy new
checks. Never migrate old receipts by adding successful defaults. Old records
remain readable for cleanup/history, and rollback disables provisioning while
preserving destroy/retry. Feature stays dormant on backend, API and UI axes
until its required real-provider qualification and wiring gates pass.

Egress Allowlist/On and live preview stay dormant. Local preview inside the
workload's loopback remains supported. Offline rebuilds use the current pinned
tools/delivery contents; no fallback network access is granted to package
installation. An application requiring external fetches is refused under Off.

## 6. Reuse and ownership keep changes inside existing lifecycle seams

| Owner               | Change after approval                                                                               | Reuse / reason                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution isolation | `crates/cognia-exec-sandbox/src/launcher.rs`, `linux.rs`, `seccomp.rs`                              | Existing bwrap namespace renderer, capability dropping, protected mounts and syscall rules. Add a strict desktop profile; do not globally alter other sandbox modes. Current generic launcher lacks the required full profile and persistent GUI bridge. |
| Guest runtime       | Proposed small `crates/cognia-desktop-guest/` binary crate plus existing image files                | No current component owns persistent namespace lifetime, protected handoff dispatch and a fixed ingress relay. Reuse the execution policy rather than copying it. A separate crate avoids linking Tauri/UI automation into the Linux guest (ADR-0196).   |
| Handoff             | `managed/handoff.rs`, `handoff_guest.py`, existing guest tests                                      | Split privilege from parsing without duplicating delivery/provenance or weakening protected receipts. Coordinate with delivery owner; no concurrent edits to its files.                                                                                  |
| Provider adapter    | `crates/cognia-e2b/src/envd.rs`, `exact.rs`; `managed/provider.rs`                                  | Fixed bootstrap/probe operations, accurate enforcement claims, sanitized evidence. No new lifecycle adapter.                                                                                                                                             |
| Qualification       | `managed/contracts.rs`, `journal.rs`, `service.rs`, `smoke.rs`, `control.rs`; Host release verifier | Versioned evidence, re-admission and native smoke. Extend current journal rather than add a competing authority.                                                                                                                                         |
| Product             | Existing sandbox types/contract/config display and both locale sources                              | Preserve lifecycle-contract seam, show combined enforcement truthfully; rebuild protocol/i18n artifacts from their owners if changed.                                                                                                                    |

## 7. Delivery phases have explicit exit conditions

The user approved the ADR boundary and implementation on 2026-10-16. All implementation phases remain conditional on their preceding verification gates. Each changed source
gets co-located tests, a changeset, both locales for new user-visible strings,
and wiring review. Rust tests remain skipped under the current instruction;
test definitions are not reported as passing. No full suite or coverage run.

| Phase / owner      | Work                                                                                                       | Verification and abort condition                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 / runtime       | Verify required namespaces, privilege drop, seccomp and UDS transport on Linux and the user's E2B template | Explicitly bounded, separately identified diagnostic resources under existing smoke authorization; report cost first and clean up. If kernel or required ingress support fails, stay dormant and return to design—no UID-only fallback.                             |
| P1 / guest runtime | Strict profile, supervisor/relay and startup ordering; immutable image build                               | Narrow Linux isolation harness: no route, no leaked FDs/helpers, required services alive, expected teardown. Simulate missing namespace/seccomp and malicious inherited sockets. Python/Node targeted checks; native compilation only with disk precheck.           |
| P2 / handoff       | Confined importer, protected receipts, same-desktop application launch                                     | Both fixed-commit and recovery-bundle flows, malicious Git/path data, tampered receipts, operation retry/uncertain ack, process-group cleanup, local preview and metadata denial. No task merge/completion side effect.                                             |
| P3 / Host          | Evidence version/provenance, protocol and UI labels, reconnect validation                                  | Old receipt rejection, namespace/profile mismatch rejection, cross-owner/generation rejection, accurate i18n, existing lifecycle-contract tests and wiring-auditor.                                                                                                 |
| P4 / native smoke  | Publish pinned recipe, register exact account template, run full lifecycle then control takeover           | Workload probe matrix plus native TTL kill/no resume, restart/delete retry, HTTP/WS auth, decoded frame, lease exclusivity/fence/revocation. Delete all paid resources/templates and verify zero running/paused resources. Only native assertions install receipts. |

Runtime target is the existing quoted 120-second smoke lifetime and existing
provider limits; added startup latency has no measured baseline yet. It must
leave sufficient time for probes and real delete retry. If it does not, fail
and revise an explicit quote—never extend the paid lifetime silently. The initial research used no paid resources. After approval, P0 used explicitly bounded diagnostics; see [P0 evidence and cleanup](2026-10-16-managed-desktop-mmds-p0-verification.md). No Rust tests or production enablement ran.

## 8. Approved ADR wording (English; accepted 2026-10-16)

Add to ADR-0228 section 6, with corresponding lifecycle/release consequences:

> For E2B managed desktops, the security subject is every process handling
> delivered source or running the desktop/application workload. These processes
> must be kernel-confined from private, link-local and metadata destinations,
> including sandbox-local MMDS. For the first egress-Off release, use a mandatory
> loopback-only network namespace with restricted process/mount/IPC visibility,
> unprivileged execution, no-new-privileges and capability removal. All desktop,
> import/Git and acceptance launch paths must enter the boundary before handling
> untrusted content. No namespace/profile capability means refusal and cleanup.
>
> Provider envd initialization is a distinct trusted control-plane activity and
> may retain its required sandbox-local MMDS access. This exception grants no
> network path, privileged socket, inherited descriptor or execution service to
> workloads. It is not a whole-VM metadata-denial claim. The published provider
> egress-Off policy remains required alongside guest-kernel enforcement. GUI
> ingress uses a fixed local bridge; no general-purpose egress proxy is added.
>
> Record provider observations and workload enforcement separately. Preserve old
> failed evidence; require a new versioned qualification bound to the exact
> image, profile, template, owner/config and session generation. Workload probes
> must include metadata and all actual launch paths; any metadata response or
> boundary bypass fails qualification. Never substitute a provider setting,
> guest-reported success or missing test for observed isolation. A recipe/profile
> change invalidates old qualifications and keeps all three product axes dormant
> until the required smoke passes.

## 9. 已批准 ADR 补充（中文；2026-10-16 接受）

建议补充 ADR-0228 第 6 节，并同步生命周期和镜像版本的后果说明：

> E2B 托管桌面的隔离对象包括所有处理交付源码、运行桌面或应用的工作负载进程。
> 这些进程必须由内核强制阻断私网、链路本地和元数据地址，包括沙盒本地 MMDS。
> 首版 egress-Off 使用仅有 loopback 的独立网络命名空间，并限制进程、挂载和 IPC
> 可见性，使用非特权身份、no-new-privileges 并移除 capabilities。桌面、导入/Git、
> 验收启动的全部路径都必须在处理不可信内容之前进入隔离边界。无法建立边界或缺少
> 必需内核能力时，必须拒绝并清理，不能退回普通启动。
>
> Provider envd 初始化属于独立的可信控制面，可保留其必需的沙盒本地 MMDS 访问。
> 此例外不能向工作负载暴露网络通道、特权 socket、继承描述符或特权执行服务；也
> 不代表“整个 VM 内的所有进程均无法访问元数据”。Provider egress-Off 策略与 guest
> 内核隔离必须同时成立。GUI 入站仅经过固定目标的本地桥接，不增加通用出站代理。
>
> Provider 侧观察和工作负载隔离证据分别记录。保留历史失败记录；新的资格版本必须
> 绑定准确镜像、隔离策略、模板、owner/config 和会话 generation。工作负载探测必须
> 包括元数据地址及所有实际启动路径；任一元数据响应或越界均判失败。不能用配置值、
> guest 自报成功或缺失测试代替实测。镜像或隔离策略变化使旧资格失效，后端、API、UI
> 三个层面均保持 dormant，直到所需真实 smoke 通过。

## 10. Decisions, review and follow-up ownership

- **Q1 (recommended):** approve the workload/control-plane distinction and the
  loopback-only namespace design above, while preserving strict workload denial.
  Alternative: require VM-wide denial including envd, keep hosted E2B blocked,
  and wait for a supported provider control or evaluate another provider. No
  implicit MMDS exception is acceptable.
- **Q2 (included in Q1 recommendation):** approve explicit combined enforcement
  provenance, a new recipe/evidence version and requalification; do not reuse
  provider-only wording or old receipts. This is required for truthful claims.

| Review item                              | Result / owner                                                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current launch coverage                  | Read-only trace identified desktop, root importer and root probe paths; addressed in sections 1–4                                                                                        |
| Existing-isolation reuse                 | Existing namespace/seccomp helpers identified; general Allowlist/proxy path explicitly rejected as strict confinement                                                                    |
| Structural review                        | Resolved importer promotion, complete later-launch confinement, independent death cleanup, bounded all-port proof and explicit descriptor whitelist; live feasibility remains unverified |
| Security boundary                        | Proposed; user confirmation required before accepted ADR changes or implementation                                                                                                       |
| Live compatibility                       | Open, owned by runtime workstream at P0; cannot be asserted from macOS/source inspection                                                                                                 |
| UI/protocol/i18n, migration and rollback | Required in P3; no implementation or success claim in this research                                                                                                                      |
| Approval follow-up                       | Managed-desktop owner; target 2026-10-16 for review request, implementation dates set only after approval                                                                                |

## Sources and local evidence

Read on 2026-10-16. Upstream source describes implementation, not a hosted
deployment attestation. Contributor comments/unmerged proposals are supporting
context only. No MMDS contents, account credentials or paid resources were
accessed during this research.

- [S1: E2B pinned MMDS route implementation](https://github.com/e2b-dev/runtime/blob/a1899fb840e1eb1ef2c0ffc751c639959ed6a144/packages/envd/internal/host/mmds_route_linux.go).
- [S2: E2B pinned MMDS initialization client](https://github.com/e2b-dev/runtime/blob/a1899fb840e1eb1ef2c0ffc751c639959ed6a144/packages/envd/internal/host/mmds.go).
- [S3: upstream MMDS question](https://github.com/e2b-dev/runtime/issues/3625) and [open clarification proposal](https://github.com/e2b-dev/runtime/pull/3627).
- [S4: Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html) and [Bubblewrap scope/limitations](https://github.com/containers/bubblewrap/blob/main/README.md).
- [S5: iptables owner/cgroup matching](https://man7.org/linux/man-pages/man8/iptables-extensions.8.html).
- [S6: Linux seccomp filtering and pointer limitations](https://docs.kernel.org/userspace-api/seccomp_filter.html).
- [S7: Linux no-new-privileges semantics](https://docs.kernel.org/userspace-api/no_new_privs.html).
- [S8: Uvicorn Unix socket/pre-opened descriptor support](https://github.com/encode/uvicorn/blob/master/docs/settings.md).
- [ADR-0228, English](../content/docs/en/adr/0228-a-managed-desktop-accepts-a-delivered-commit.md) and [Chinese](../content/docs/zh/adr/0228-a-managed-desktop-accepts-a-delivered-commit.md); [ADR-0221](../content/docs/en/adr/0221-a-remote-sandbox-is-a-provider-behind-the-same-seam.md).
- Local entrypoints: `crates/cognia-e2b/src/envd.rs`; `crates/cognia-automation/src/cua_sandbox/image/{entrypoint.sh,startup.py,server.py,menu.xml}`; `managed/{handoff.rs,handoff_guest.py,provider.rs,contracts.rs,service.rs,smoke.rs,control.rs}` under the same `cua_sandbox` directory.
- Local reuse: `crates/cognia-exec-sandbox/src/{launcher.rs,linux.rs,seccomp.rs,net_proxy.rs}` and `crates/cognia-sandboxd/src/{init.rs,serve.rs}`. No reusable persistent desktop namespace/GUI bridge was found.

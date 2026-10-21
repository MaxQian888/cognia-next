# One workspace execution plan supports Lima and other runtime backends

| Field              | Value                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Research proposal; no implementation or runtime qualification                                                                                                                                     |
| Author / date      | Codex / 2026-10-20, Asia/Shanghai                                                                                                                                                                 |
| Depth              | Heavy: tool dispatch, sidecar, Rust Host, plugins, native IPC, state and multi-device compatibility                                                                                               |
| Request            | Introduce Lima through an extensible architecture after researching the current execution topology                                                                                                |
| Confirmed scope    | Workspace files/search, Shell, workspace terminals, external Agent processes and workspace stdio MCP share one resolved environment; browser/desktop/service actions use explicit external grants |
| Canonical artifact | This plan; supporting evidence is linked in section 16                                                                                                                                            |
| Owners / reviewers | Runtime maintainer, sidecar maintainer, workspace maintainer, security reviewer, desktop/mobile maintainer; role assignments are proposed                                                         |
| Delivery           | Phased opt-in; no branch, commit, deployment, installation or VM creation is authorized by this document                                                                                          |

Adversarial amendment: the second review found ten actionable design gaps.
Sections 6 and 11 now separate isolation floors from revocable grants and add
activation/revocation barriers. Sections 8–11 define MCP provisioning, CLI
reachability, crash-limit capabilities, VM-wide cancellation, revision
reconciliation and an execution-group trust boundary. The full disposition is
recorded in the [second review](../research/2026-10-20-workspace-execution-adversarial-review.md).

## 1. Resolve a workspace execution plan once, then enforce it at every resource boundary

**Recommendation:** extend Cognia's existing execution resolver, sandbox provider set and Task Workspace ownership. Add one Host-admitted workspace execution plan with a stable runtime reference. Lima becomes one native provider-set member; tool-specific compatibility adapters consume that reference. Do not create another agent loop, another sandbox pool, or a second workspace history system.

The user approved the first-phase scope: files, Shell, terminals, external Agents and local MCP belong to one workspace environment. Browser/desktop actions remain external resources requiring explicit grants. These are resource-placement guarantees: a handler may remain on the Host while its filesystem/process port acts inside the VM.

Lima's name is not evidence of network confinement, snapshots or cancellation. The pinned upstream research found that default networking reaches host loopback, noninteractive `shell --sync` copies changes back automatically, VZ snapshots are unimplemented, and stopping a local SSH command does not prove guest descendants stopped. The adapter must report these boundaries accurately and reject unsupported requirements.

### Goals and acceptance are paired

| Goal                          | Confirmed baseline                                                    | Required result                                                                                                                 | Acceptance       |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| G1: clear placement           | Four shell tiers, separate terminal/browser/MCP routing               | Every tool result identifies its effective resource location, policy and generation                                             | A1, A2, A10      |
| G2: one workspace boundary    | Direct Node filesystem/process tool bodies coexist with sandbox tools | All approved workspace operations reach one admitted execution group or refuse; CLI/MCP compatibility is explicit               | A3–A6, A23–A25   |
| G3: extensible providers      | One provider set already supports complete backend members            | Lima and existing Docker adapters use the same admission/ownership contracts; fake backend exercises the same conformance suite | A7, A8           |
| G4: honest isolation          | Provider names and generic tier fields are insufficient               | Effective file/network/process capabilities have evidence and explicit limits                                                   | A8, A9           |
| G5: preserve work and control | Existing recovery and workspace histories have different owners       | Revocation, cancellation, crash and revision/export transitions preserve explicit outcomes and supported guarantees             | A11–A14, A18–A22 |
| G6: compatible rollout        | Existing v1 OCI spec and older readers are strict                     | Non-opted legacy behavior stays unchanged; activation and supported rollback preserve opted-in isolation floors                 | A15–A17          |

### The boundary is deliberately smaller than the entire application

In scope: Linux workspaces on macOS/Apple Silicon Lima first; backend-neutral ownership, capabilities, tool-resource routes, filesystem/process/PTY/MCP ports, external Agent placement, exports and multi-device inspection.

Compatible later: Lima on Linux, additional Lima engines/architectures, Lume/macOS guests, a qualified browser inside the same instance, Windows-native providers, backend-native snapshots and additional provider plugins. These are not advertised until qualified.

Excluded from the first release: operating the user's Mac desktop inside Linux, transparent migration of arbitrary running processes, translating devcontainer OCI images into VM disk images, accepting repository-supplied Lima provisioning YAML, and claiming a compromised Host or an arbitrary trusted Host plugin is contained by its own VM manager.

## 2. Existing contracts remain owners; the missing part is resource placement across tools

Confirmed source facts:

| Existing owner                                         | Current responsibility                                            | Reuse / limitation                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lib/ai/agent/execution/agent-execution-service.ts`    | Authoritative Agent rail selection and capability checks          | Extend the existing result with a workspace plan reference; do not replace its resolver                        |
| `packages/agent-config-types/src/agent-execution.ts`   | Immutable Agent execution spec and identity                       | Link resource placement to this identity; Agent/model capabilities remain separate                             |
| `lib/sandbox/session-runtime.ts`                       | Session generation, sandbox tool execution and Computer Use       | Preserve compatibility aliases; widen resource dispatch through Host authority, not a second mutable singleton |
| `lib/sandbox/run-environment.ts`, `cognia-environment` | Resolve and re-admit image/environment declarations               | Preserve v1 OCI digest and approval semantics                                                                  |
| `cognia-sandbox-pool::ProviderSet`                     | One sandbox arm with complete backend members                     | Register a native Lima member; it need not pretend to be `SandboxDockerApi`                                    |
| `SandboxRuntimeControl`                                | Task shell, port access, snapshots and tool bridges               | Extend resource-neutral operations; remove concrete Docker ownership from new contracts                        |
| `cognia-task-workspace`                                | Logical roots, working copies, changesets, revisions and adoption | Keep this as the source/change authority; guest workspace is an execution replica                              |
| `AgentProcessHost` / `AgentFileHost`                   | Process and ACP host callbacks                                    | Bind all callbacks to the same immutable plan                                                                  |
| `HostedTerminalProcess`                                | PTY write/resize/kill/replay/backpressure                         | Implement a guest transport adapter behind the existing terminal Host                                          |
| `sidecar/src/platform/host-rpc.ts`                     | Sidecar-to-Host request/response                                  | Carry bound workspace operations over the existing channel                                                     |

There are two different TypeScript interfaces named `AgentExecutionEnvironment`: Host facts for rail selection and a local Tauri team lifecycle abstraction. Neither is a generic VM registry. Do not expand either ambiguous name into a third concept.

The current four shell tiers are `os`, `container`, `microvm`, `cua-desktop`. The connection lifecycle registry has two pairs, Docker and E2B; the remote pool config has two kinds, E2B and Kubernetes. These observations are from this session's source reads, not evidence that any backend is running.

## 3. Separate Host, backend, instance, workspace and Agent runtime

| Term                  | Meaning                                                               | Example                                             |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Controller            | Device presenting the chat and UI                                     | Mac, phone, browser                                 |
| Execution Host        | Trusted Cognia process admitting and owning execution                 | Desktop Rust shell or `cognia-server`               |
| Backend               | Implementation owning runtime resources                               | OS process, Docker, Lima, E2B, Kubernetes           |
| Backend configuration | One configured installation/account/endpoint                          | Cognia-managed Lima installation; named E2B account |
| Runtime instance      | Concrete resource owned by a backend                                  | One Lima VM, one container or remote sandbox        |
| Workspace             | Existing Task Workspace identity and logical root set                 | A task's working copy, including additional roots   |
| Workspace binding     | Generation-scoped relationship between workspace, instance and policy | Workspace W on VM I, generation 7                   |
| Agent runtime         | Protocol/agent implementation executing a turn                        | Cognia sidecar rail, Codex app-server, ACP Agent    |
| Resource route        | Where one tool's actual effect is permitted                           | Bound workspace, external browser, controller UI    |

An **execution group** is the set of cooperating Agent, Shell, PTY and MCP
processes intentionally sharing one approved capability ceiling and workspace
view. With guest root in the threat model, the VM is this group's trust boundary,
not a boundary between its individual jobs. Workspace persistence does not imply
that a used guest disk is safe to reuse for a different execution group.

QEMU and VZ are engines selected by the Lima adapter. Colima is a separate container-management product built on Lima. They are not all interchangeable provider names. A future direct QEMU provider would need its own lifecycle implementation and qualification.

## 4. Extend the existing provider set with a small Host-owned resource contract

```text
 Controller: desktop / Web / phone / CLI
                 |
 Existing AgentExecutionService + project environment resolution
                 | proposed plan reference, not user-chosen instance handles
 ================= authenticated Host boundary =================
 Existing admission + workspace owner + provider set
        | admitted binding, policy ceiling, generation and resource routes
        +---- workspace file / process / PTY / stdio MCP ports
        |             |
        |      backend member: OS | Docker | Lima | E2B | Kubernetes
        |             |
        |      existing sandboxd protocol + backend transport
        |             |
        |      execution workspace and workload processes
        |
        +---- explicit external grants: browser / desktop / remote API / UI
 ================= untrusted workload boundary =================
```

The Host remains the authority; a controller callback cannot choose a different workspace machine. A backend supplies runtime operations, while policy, approvals, audit and workspace adoption remain shared.

### Three existing seams are extended

1. **Resolution:** the existing Agent execution service and run-environment resolver jointly produce a proposed `WorkspaceExecutionPlanV1`. The Agent spec references it; there is no competing Agent selection algorithm.
2. **Resource authority:** the existing provider set owns the admitted plan and selects its member. Introduce the binding/operation facade inside `cognia-sandbox-pool`; its storage and shared policy helpers extend `cognia-environment`. This is an internal refactoring, not a new public service or independent pool.
3. **Adapters:** each resource client supplies the same plan reference. Existing sandbox, terminal, MCP, file and external Agent entry points become adapters to that facade. An unsupported operation is absent or refused, never emulated on another machine.

New modules are justified only for the Lima-specific lifecycle/transport and the missing common binding ledger. They belong under existing crates. No new top-level crate is proposed initially; the Rust architecture gate determines placement when implementation begins.

Two existing container-specific projections must be corrected: `ProviderView.remote` currently derives from whether limits exist, so add explicit locality (`host-local` / `remote-service`) rather than calling a quota-limited local VM remote; `SnapshotRuntimeLease` retains a Docker backend, so new common operations use an opaque provider-owned lease and keep the old Docker lease behind its compatibility adapter. Neither change gives Lima snapshot support.

For v2 selection, an explicit backend configuration wins and must satisfy all requirements. `auto` considers only the user's admitted candidate set, filters by Host/platform, realization, capability and grants, then uses the Host's configured preference order. Remote cost/data transfer requires an eligible grant. OS, Docker and Lima have distinct IDs; legacy `local` remains the old Docker alias on v1 only. No candidate means refusal, not an implicit downgrade or newly chosen cloud service. Locality, quotas and workload isolation are independent metadata, with negotiated old-client status projections.

## 5. A Host-admitted plan freezes routes, while capabilities describe evidence

The following are proposed logical schemas, not existing code:

```typescript
type WorkspaceExecutionPlanV1 = {
  version: 1
  hostRef: string
  accountRef: string
  workspaceBundleRef: string
  executionGroupRef: string
  sourceRevision: string
  effectiveManifestDigest: string
  environmentRef: string
  environmentDigest: string
  backendConfigRef: string
  policyDigest: string
  mode: "legacy" | "isolated-workspace"
  toolCatalogDigest: string
  routes: Record<string, ResourceRoute>
  requires: RuntimeRequirement[]
}

type ResourceRoute =
  | { kind: "workspace"; logicalRootIds: string[] }
  | { kind: "external"; resourceRef: string; grantRef: string }
  | { kind: "controller"; action: "present-ui" | "request-input" }
  | { kind: "pure" }

type RuntimeBindingRef = {
  bindingId: string
  generation: number
  hostRef: string
}
```

Only the Host returns an admitted binding; a renderer plan is a proposal. The Host re-resolves account/workspace access, approved environment, installed driver, tool catalog, grants, effective capability evidence and resource budgets. Unknown schema fields/versions, unclassified tools, mismatched account/Host and stale generations fail before execution. IDs are references, not bearer authorization.

Each operation carries `bindingId`, `generation`, `operationId`, deadline and owner/run identity. Host authorization derives the actor from the authenticated transport; clients cannot self-assert authority by filling these fields. Sidecar RPC calls use a Host-owned session mapping and cannot name another account's binding.

Operation results are versioned objects carrying the effective binding, tool/resource route, output truncation flags, an optional typed reason and a terminal outcome: `completed`, `failed`, `cancelled`, `timed-out` or `outcome-unknown`. Typed failures include `runtime_unauthorized`, `runtime_generation_stale`, `runtime_capability_unsupported`, `runtime_policy_unenforceable`, `runtime_configuration_changed`, `runtime_unavailable`, `workspace_revision_conflict` and `runtime_operation_unknown`; only reads and acknowledged idempotent operations are automatically retryable. A timeout is not a successful cancellation.

Creation/download/boot returns a durable pending operation reference over the existing Host request/event plane. It does not hold a short-lived default RPC open for a 90-second boot. Readiness is required before exposing execution tools or starting model spend; deadlines apply independently to provisioning and the later workload command. Metadata frames are proposed at <=64 KiB and binary data frames at <=64 KiB; larger workspace data uses bounded chunk transfer with a manifest, not a large JSON argument.

### Capability evidence is per operation and environment

Reuse the existing snapshot split (`filesystem_checkpoint`, `fork_from_checkpoint`, `pause_resume`, `memory_resume`) rather than adding a single `snapshot=true`. Add equally explicit operation evidence:

| Dimension     | Required evidence fields                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Files         | root scope, read/write/search/atomic replace, symlink handling, guest-local storage vs live host mount |
| Process       | argv/stdin streaming, env policy, descendant cancellation and deadline enforcement                     |
| PTY           | real PTY, resize, signals, replay, flow control                                                        |
| Network       | requested/effective mode, enforcement boundary, control-plane exceptions and probe/version             |
| Isolation     | shared kernel vs VM boundary, tenant/workspace sharing, Host-file exposure                             |
| Lifecycle     | create/start/inspect/stop/delete; pause, memory resume and checkpoint reported separately              |
| Tool coverage | required tool families routed, unsupported IDs, catalog/policy digest                                  |

Evidence includes driver version, guest OS/architecture, image/template digest, configuration digest, probe suite version/time and runtime generation. It is invalidated by changes to any of these. A successful guest handshake proves protocol compatibility; a guest's assertion cannot establish Host-side isolation against a compromised guest root.

Deadline evidence additionally distinguishes `host-supervised` from
`out-of-guest-watchdog`, including whether enforcement survives loss of the
Cognia Host process. A required hard deadline cannot be satisfied by an
in-guest lease when guest root is untrusted. Revocation evidence similarly
distinguishes stopping new authorization from verified termination of existing
work and from externally issued credentials reaching their expiry.

## 6. Workspace tools cannot escape through another spelling, callback or terminal

Tool classification is compiled Host-owned metadata for trusted built-ins. Plugin metadata is a request for a route, not authority to grant one. A tool with undeclared resource access is unavailable in isolated mode.

| Surface                                   | Isolated-workspace behavior                                                                        | Required change                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Read/write/stat/list/glob/grep/edit/patch | All filesystem IO resolves logical workspace roots in the bound instance                           | Replace direct sidecar Node FS IO with session-scoped file ports; reuse tool logic and `cognia-files` validation helpers                   |
| Shell, Git, process helpers               | Executables and filesystem effects run inside the instance                                         | Session-scoped process port over existing Host RPC; no host `spawn` fallback                                                               |
| LSP/AST/index helper with workspace IO    | Guest resource port or unsupported                                                                 | No hidden Host scanner under an isolated label; native helper processes require the same binding                                           |
| SDK native Read/Bash/Edit and aliases     | Disable when the SDK cannot bind their IO; expose the existing Cognia tool adapter backed by ports | Check bare, SDK and MCP-prefixed names; no prompt-only instruction                                                                         |
| `sandbox_*`                               | Compatibility aliases to the same bound resource operations                                        | Preserve published names and ceilings; retire duplicate location selection after migration                                                 |
| Workspace terminal                        | Guest PTY via `HostedTerminalProcess` adapter                                                      | Terminal session captures binding/generation at creation; an explicitly separate Host terminal is labelled and outside the workspace scope |
| External Agent native tools               | Agent process starts inside the bound instance                                                     | Protocol stays on Host; child runs guest CLI with managed model/git leases                                                                 |
| ACP file/terminal callbacks               | Same binding as its Agent process                                                                  | No Host filesystem callback even if it is convenient for the protocol adapter                                                              |
| Local/workspace MCP stdio                 | Server child and its cwd/files live in the bound instance                                          | MCP lifecycle uses the process port; no renderer/Host stdio spawn                                                                          |
| Remote MCP HTTP/SSE                       | Explicit external endpoint grant or deny                                                           | HTTP can also target loopback; classify resolved resource, not transport name                                                              |
| Browser and Computer Use                  | Explicit external resource grant; separate visible target                                          | Do not silently attach to local Chrome or desktop when a VM tool fails                                                                     |
| Search/Reader/API                         | Explicit configured external capability                                                            | Disclosure/network policy remains separate from file placement; outbound locally derived text retains the PII gate                         |
| Artifacts/editor/UI                       | Controller presentation, or bound workspace access through ports                                   | Reading a buffer is data access, not automatically a harmless UI operation                                                                 |
| Workflow/Bot/schedule/subagent            | Inherit or narrow the parent's binding/grants                                                      | Trigger origin does not decide the machine; unattended runs cannot approve new grants                                                      |

The first usable isolated-workspace slice must cover files/search + Shell + workspace PTY + external Agent + stdio MCP together. Until then the profile is experimental/incomplete and cannot be presented as a complete isolated workspace. Individual low-level capabilities can be tested earlier without granting the product-level label.

The existing controller tool proxy remains for UI/external actions. Workspace calls delivered to a controller must re-enter the admitted binding's Host; they cannot execute local resource IO. A remote Host requiring this protocol refuses old clients without it.

### Host-enforced floors close the old-command bypass before opt-in

P0 persists an `isolated-workspace` minimum in a separate floor record for each protected workspace/account identity and indexes its canonical logical/source roots; execution grants reference that floor but do not own its lifetime. This check sits in the shared native file/process/terminal/MCP/Agent entry points, including old Companion RPC and local Tauri commands. A missing plan reference is legacy only where that Host floor permits legacy. A v1 request touching a protected workspace is refused before Host IO; a client cannot remove the floor by omitting fields or claiming another surface.

File requests are checked against authenticated ownership and canonical roots, including symlinks. Arbitrary unscoped Shell/PTY/process requests cannot be proven safe by inspecting `cwd` or parsing a command: a command can change directories later. Such agent-capable unscoped calls are refused for an identity subject to the isolation floor unless a separate, explicit human Host-operation authorization is supplied. The caller cannot self-label a request as manual. This is a deliberate compatibility restriction for opted-in accounts; accounts without a floor retain legacy behavior. A migration inventory must cover every alias and native dispatcher before enabling the mode.

Opt-in activation uses an identity-wide, durable admission barrier; it is not
an SQLite transaction spanning process execution. Under that barrier, record
`activating` and advance the admission epoch **before** enumerating old work.
From that point reject new legacy admissions, queued launches and attachments
for the affected identity. Each resource effect rechecks its captured epoch
immediately before dispatch; requests admitted under an earlier epoch cannot
spawn after the barrier. Drain includes live processes, queued/in-flight
requests, PTYs, MCP children and sessions that were admitted but not launched.
Only after all are settled or fenced does the floor become `required` and new
bound work become eligible. If draining fails, retain `activating` and report
incomplete activation; lifting the barrier is a separate explicit recovery
decision. On restart, restore the barrier before serving execution endpoints.

Host administrative terminals are explicitly external user operations and
their grants are not inherited by isolated Agents. Removing an execution grant
does not remove the identity's isolation floor. Floors have their own durable
record and can be lowered only through a distinct human-authorized policy
transition with its own drain and audit receipt.

Trusted frontend plugins run with the Host application's trust and are outside the compromised-workload threat boundary. Arbitrary third-party Host callbacks are withheld in isolated mode. First-phase external grants support known brokered operations; arbitrary plugin execution on the Host is not an acceptable substitute for an operation-specific grant.

## 7. Preserve OCI v1 exactly and add an explicit machine-native realization

`EnvironmentSpecV1.image` is a required OCI image identity. A Lima disk image or YAML is not that image. Ignoring the field would violate admission and the user's selection.

Introduce a capability-negotiated placement envelope with a closed union:

```text
RuntimePlacementV2
  common: backendConfigRef, workspaceBindingProposal, requirements, policy
  realization:
    oci-v1       -> existing EnvironmentSpecV1, unchanged digest and semantics
    machine-v1   -> MachineWorkloadSpecV1

MachineWorkloadSpecV1
  approved machine profile identity and version
  guest OS + architecture + immutable boot artifact digest
  generated driver configuration digest + supported driver version
  verified agent/tool bundle digest
  workspace roots and source revision manifest
  user/process limits + environment + setup/lifecycle declarations
  filesystem/network/security requirements + evidence references
```

Common admission helpers validate permissions, artifact provenance, quotas, source revisions and policy floors. Provider-specific realization validates the boot artifact and driver configuration. Repository lifecycle setup runs only inside the workload boundary. Machine templates and Host provisioning are controlled by the Host owner, never arbitrary repository scripts.

An OCI environment can later run a container inside a Lima carrier, but that is a different realization with separate instance/workload identities. A shared carrier VM does not make every container a separate VM isolation domain.

Do not modify v1 canonical bytes, append fields old Rust readers reject, or upcast a running legacy session into stronger guarantees. Negotiation precedes emitting v2. The existing Agent execution spec version must be advanced coherently when it gains the plan reference; an absent reference always means legacy, never verified isolation.

## 8. Lima owns only machine lifecycle and its controlled transport

The proposed native Lima member consists of two internal components:

- Lifecycle adapter: detect approved `limactl`, create/inspect/start/stop/delete only Cognia-owned instances, validate resolved configuration and resource limits.
- Runtime transport: connect the existing guest supervisor protocol through a fixed noninteractive SSH/stdio entry point; provide guest files, processes, PTY and bounded service streams through shared interfaces.

The first qualification target is Lima **v2.2.1**, macOS Apple Silicon, ARM Linux with VZ. This is the pinned release observed during research, not an installation performed here. Other versions require their own qualification record; a newer binary is not automatically supported.

### Managed configuration prevents user defaults from widening access

Use a Cognia-owned `LIMA_HOME`, namespaced instance IDs and an ownership manifest bound to the Host deployment. Validate effective configuration after Lima's defaults/overrides merge, before every start/acquire. A changed configuration quarantines the instance until explicit reconciliation. Do not adopt or delete unrelated user instances.

Generated profiles disable host-home mounts, SSH agent forwarding, ambient proxy/credential propagation and automatic workload port forwarding. They expose only audited control facilities; installation/provisioning does not execute guest-provided Host commands. Driver discovery and all CLI arguments use argv arrays, bounded output, sanitized environment and fixed template sources. Lima's `list --format json` is parsed as JSON Lines, with explicit unknown-state handling.

Initial distribution discovers a user-installed approved Lima binary and verifies its resolved path/version; no automatic privileged package-manager install occurs. Pin guest/bundle artifact digests, verify downloads and account for cache/disk cost before provisioning. Bundling Lima, QEMU or guest images later requires an actual artifact/license inventory, signatures/notices and an update/rollback mechanism. Lima's Apache-2.0 license does not cover every dependency or guest image. An incompatible upgrade withdraws qualification rather than silently changing live resources.

Workspace contents are transferred into guest-owned storage, not live-writable mounts to the source checkout. The guest user is unprivileged for ordinary tools. Linux guest root is treated as potentially compromised for Host protection: no Host secrets, sockets, broad RPC bridge or filesystem mounts are available to it.

### Guest services extend sandboxd rather than duplicating tool algorithms

The current `sandboxd` provides supervised stdio sessions, renew/signal and authorized port streams. Filesystem and real PTY services do not exist there yet and are explicit implementation work. Extend its versioned protocol with bounded file operations and PTY frames, reusing file-confinement code and `HostedTerminalProcess` semantics. Keep editing/search algorithms in their existing owning modules using injected IO ports.

Data frames have length limits, backpressure and stream IDs; control frames have their own bounded priority so output cannot starve cancellation. File writes are atomic with expected content hash; path resolution is relative to admitted logical roots and rejects traversal, symlink escape and special files. Invalid framing closes the binding. Never log raw stdin, file bodies, credentials or MCP messages.

### End-to-end streaming extends the existing Host RPC/event plane

Current sidecar Host RPC is a single JSON request/result with no streaming or remote cancellation; its timeout only stops waiting. P1 explicitly adds `runtime.open`, `runtime.write`, `runtime.credit`, `runtime.close` and `runtime.cancel` operations to that plane. `open` returns an authorized stream reference bound to Host/session/binding/generation/operation. Host-to-sidecar frames use the existing process event infrastructure with a newly registered internal runtime-I/O event descriptor, never an arbitrary client-selected endpoint. Frames carry stream ID, sequence, channel, generation, bounded binary payload and terminal status. Register the descriptor and forwarders in desktop and Rust-backed headless Host boots; CLI controllers consume that Host protocol as specified below.

Use independent control priority, a proposed 256 KiB per-stream pending buffer and aggregate Host admission budgets. Producers pause on exhausted credit; a peer that cannot honor flow control closes with an explicit protocol failure. MCP/Agent protocol bytes are never truncated to fit text-result limits. Terminal replay retains its existing bounded replay/gap semantics, while rendered command-result text may truncate with flags. Disconnect revokes/parks the owning stream and triggers the defined job cleanup policy; reconnect requires sequence/generation reconciliation. Control acknowledgments come from the same captured Host, not whichever UI target is now active.

For external Agents, the existing agent bundle and gateway/git proxies are
reused. Provision a verified guest-native bundle; do not inherit Host model
provider keys or the user's login environment. Live Agent auth/process state
belongs to its execution group. Only explicitly selected non-secret conversation
and workspace data is eligible for later export/resume; copying a guest home or
system disk is not a cross-group resume mechanism.

### MCP launch compatibility is admitted before spawning the server

Introduce an approved `GuestMcpLaunchSpecV1` as a projection of a configured
server, not a raw copy of Host `command/args/env/cwd`. It identifies server
configuration/version, guest OS/architecture, verified artifact/dependency
digests, required Node/Python/native runtime, guest argv, logical workspace cwd,
resource limits and credential requirements. Host-absolute executable paths
and macOS-native binaries are not portable guest launch definitions. Resolve
approved packages through the guest bundle or a digest-verified guest install;
downloads require the effective network grant. Missing runtime, unsupported
architecture, unapproved dependencies or incompatible auth returns a precise
preflight refusal before model spend. The first conformance fixture is a
secret-free, packaged guest stdio server; compatibility with arbitrary existing
Host MCP definitions is not claimed.

Credentials have three admitted modes: no credential; a Host broker that owns
the real credential and exposes only the approved operation set; or an
explicitly delegated, server-scoped short-lived credential with a documented
expiry/revocation capability. Never copy the Host login environment or permanent
provider keys. Guest root can read a delegated credential, so its full authority
belongs to the execution group's approved ceiling. If a server requires an
unbrokerable permanent credential or stronger revocation than it supports,
that configuration is unavailable. MCP server dependency/configuration changes
invalidate the plan catalog and require fresh admission.

### A standalone Node CLI is not implicitly a Rust execution Host

The current CLI `StdioTransport` handles a small explicit Host-RPC method map;
it has no Rust pool registries. Merely forwarding new event names cannot create
that authority. The initial isolated-workspace path therefore requires a
qualified Rust desktop/headless Host. A CLI can use it as an authenticated
controller, with the Agent loop and admitted resource authority owned by that
Host and all control/events captured to it. This requires an explicit CLI
Companion/controller adapter and capability negotiation, included in P3; it is
not an existing feature assumed from Node's generic transport shape.

Pure standalone Node mode retains legacy behavior only for independently owned
local legacy workspaces. It rejects an isolated-workspace request with
`runtime_host_required` before local filesystem/process/MCP operations. A
Host-owned workspace/resource reference always resolves through its owning
Host, including requests omitting a mode field. If the owner or its policy
cannot be verified, refuse; never drop the reference or reinterpret its path as
a local legacy workspace. Owner metadata locates authority, not a second floor
store. A future Node-native backend can implement the same conformance contract
separately.

The floor governs resources mediated by the qualified Host and supported
controllers. It is not an OS-wide restriction on independently user-launched
programs: a trusted operator running an arbitrary standalone CLI against local
paths is outside that guarantee, like replacing the Host with a pre-enforcement
binary. Do not present pure Node legacy mode as inheriting another Host
workspace's isolation assurance. Desktop, headless,
paired Web/mobile and Host-backed CLI acceptance are distinct; unsupported
Host OS/driver combinations remain unavailable.

## 9. Network guarantees and cancellation are independent of the VM label

### Initial Lima capabilities are intentionally narrow

| Property                                       | v2.2.1 VZ evidence                                    | First-phase policy                                                                            |
| ---------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| VM lifecycle / Linux guest                     | Available upstream                                    | Requires real qualification on target host                                                    |
| Host filesystem isolation                      | Default home sharing must be removed                  | No-host-mount profile and probes are mandatory                                                |
| Files / process / PTY / stdio MCP              | Needs Cognia guest services and route migration       | Cannot advertise complete workspace until all are tested                                      |
| Network `on`                                   | Default user-mode network can reach Host loopback/LAN | Explicit broad network grant only; UI states Host/LAN access is not restricted                |
| Network `off` / `allowlist` against guest root | No suitable released Lima contract established        | Unsupported; reject these requirements until an outer enforcement implementation is qualified |
| Pause / memory resume                          | No generic Lima pause contract established            | Unsupported; expose cold stop/start only                                                      |
| VZ VM checkpoint / fork                        | VZ snapshot methods unimplemented                     | Unsupported; use workspace changesets/export, not a fake VM snapshot                          |
| Stop one guest job                             | SSH client termination is insufficient                | Supervisor cancel plus verification; escalate to force-stop the exclusive VM when required    |

`HTTP_PROXY`, guest DNS and a guest firewall are not proof of root-resistant egress filtering. Any future strict egress mechanism must be controlled outside the untrusted guest, isolate the workload NIC, block Host/private/link-local/metadata destinations as required, and preserve only named management/gateway/git channels. It must be tested with raw sockets, alternate DNS, IPv6 and guest-root tampering. Adding such a mechanism is a separate qualified backend capability, not a checkbox in Lima YAML.

The plan never widens a request: a user asking for `off`/`allowlist` cannot be run with `on`. Experimental Lima with explicit `on` can validate workspace placement, but production profiles requiring restricted egress stay blocked. Broad `on` also means arbitrary guest commands may contact endpoints; Cognia's per-tool external grants cannot claim to prevent network access permitted at this lower layer.

### Cancellation has an acknowledged result, including uncertainty

Commands have Host operation IDs and guest job IDs. Normal cancellation sends a control request to terminate the job group/cgroup, waits for terminal status, drains bounded output, then returns `cancelled`. Killing `limactl` alone returns no such guarantee.

With an untrusted guest root, a guest acknowledgment alone is not proof of descendant death. If the required cancellation guarantee cannot be established, stop the entire exclusive instance through the Host driver and verify it is stopped. If that also cannot be observed, return `outcome-unknown`, revoke bridges and block further execution pending reconciliation. No successful cancellation is fabricated. Shared instances with unrelated owners are not allowed in the initial Lima profile.

Escalation to VM stop is an **instance-wide cancellation barrier**. First fence
new operations and credential/stream renewals, advance the generation, and
revoke the group's bridges. Stop the VM through the trusted driver. Once stop
is observed, settle every attached Agent, PTY, MCP and command with either its
already verified terminal result or `cancelled` with typed
`reason: "instance-stop"`; otherwise their state remains `outcome-unknown`.
The reason explains the existing outcome; it does not add a separate terminal
state outside the common versioned result contract. Notify all affected controllers, not
only the caller that cancelled one Shell. Preserve the disk and undelivered
changes. Recovery creates a newly admitted generation; a stopped instance
cannot resume old streams, job IDs or bearer leases. The product must disclose
that cancelling a job can interrupt all work in its execution group.

Lima's initial profile offers only Host-supervised deadlines. The existing
guest supervisor's UID checks, timers and renewal protocol are not a trusted
deadline mechanism against guest root after the Cognia Host dies. If a task
requires a hard expiry under that failure model, admission requires an
independent out-of-guest watchdog or provider-native TTL, otherwise refuses.
Such a watchdog is future qualification work: it must survive Host loss and
stop only its owned instance at the absolute deadline. Without it, report
`hostCrashSafeDeadline=false`; automatic stop on the next Host reconciliation
is not an on-time guarantee. Do not advertise this initial Lima profile for
unattended workloads requiring a hard lifetime bound.

## 10. Workspace transfer and adoption preserve the existing changeset authority

Use Task Workspace logical roots and existing revision/changeset/adoption records. The guest workspace is a replica scoped to one binding; its local path is an implementation detail. Host paths are never interpreted as guest paths by string concatenation. Multi-root requests carry logical root IDs and relative paths; additional roots require independent admission.

Initial population transfers the selected Task Workspace revision, including
tracked binary fixtures/tools, executable modes, approved uncommitted content
and explicitly approved ignored files. A file is not excluded merely because
it is a native binary; runtime compatibility and transport fidelity are
different decisions. Exclude undeclared Host-generated caches, unapproved
Host cache links and unrelated home content. Credential-path restrictions
remain mandatory. If any selected content must be omitted by policy, present
that refusal or explicit projection: record both the requested revision and
the effective manifest digest, require the applicable approval, and never
claim the projected tree is the original revision. Missing projected files
are not guest deletions during export. Resolve symlinks at the source; reject
escaping roots, special devices and unsafe archive entries. Transfer to
staging, check hashes/limits, then atomically install the effective revision.

Guest edits create a staged result manifest and changeset. Applying to the user's source checkout is a separate Host-side action through the existing adoption queue, with expected base/content preconditions. A concurrent user edit produces `conflict`, never overwrite. Binary files, renames, executable bits and approved symlinks have explicit normalized manifest entries. Untrusted paths, Git hooks/config and archive metadata cannot trigger Host execution during import.

Do not use `limactl shell --sync` for production transfer or approval: the pinned implementation copies back automatically without a TTY. VM disk snapshots, filesystem checkpoints, Task Workspace snapshots and changeset adoption remain distinct operations.

If export fails, retain the instance as `held` and record the failure durably. Automatic deletion is blocked until verified export/adoption or an explicit discard decision. A disk quota or retention deadline produces an actionable held-resource state; it does not silently destroy undelivered work. Quiesce workload writes before producing a consistent export.

### Revision changes reconcile the active guest instead of restoring only a Host path

Track requested source revision, effective input manifest, guest working
revision, last exported revision and restore lineage in each binding. Task
Workspace owns the revision/history/adoption records; the admitted guest
owns the active working tree. A Host execution-root mirror is a base/export
cache while that binding is active, not a second writable live authority.

Before reconnect/acquire, compare these identities and the observed instance
incarnation. An authoritative restore, branch/base replacement, source
manifest change or environment replacement invokes one workspace transition:
fence new operations, drain the whole execution group, stage/export unexported
changes or enter `held/conflict`, then install the selected revision atomically
under a new generation. A dirty guest is never silently overwritten or reused
under a different base. Restarted/stopped instances also require this check;
instance name and workspace ID alone are insufficient. Editor buffers, PTYs,
MCP children and Agent callbacks holding the old generation must rebind.

Integrate the existing Task Workspace restore contract through this transition.
Its current `restore_run_snapshot` materializes a Host execution root; the
review found only a test caller, so this is a contract-preservation requirement,
not a claim that a currently wired UI restore is broken. New restore callers
must not mutate the Host mirror and then leave the guest on a later revision.

## 11. Durable ownership fences every operation and survives controller changes

### Instance and binding states are separate

```text
Instance: provisioning -> ready -> stopping -> stopped -> starting -> ready
                         |                                  |
                         +--------------> deleting -> deleted
Any nonterminal state -> reconciling -> ready | stopped | faulted | held

Binding: pending -> active -> draining -> released
                   |              |
                   +-> revoked ---+
```

Ready is a lifecycle state, not a claim that a tenant has permission. Running jobs and active leases are separate from instance status. Pause/resume appears only when a backend advertises it, with explicit memory semantics.

Instance ownership includes Host deployment, backend configuration, account,
execution-group ID, workspace identity, admitted grant/policy digest and
architecture. Cooperating Agent/PTY/MCP/Shell jobs share the group's approved
ceiling. They are not isolated from one another against guest root. A narrower
child grant requiring infrastructure enforcement needs a separate group and
instance, with its own working copy; a tool allowlist alone is not that boundary.

The initial Lima profile uses a fresh VM/disk from approved boot artifacts for
each independently authorized group. A persistent **workspace** is restored
from explicit revisioned data, not by reusing a guest's entire mutable system
disk or login state. Host caches may retain immutable verified base artifacts.
Reconnect within an unfinished group can retain its instance only while the
same authorization ceiling remains valid; it cannot introduce stronger or
independent grants. On group completion, stronger authorization or trust-domain
change, drain/export and rebuild. A retained `held` disk is evidence/recovery
material, not an eligible future execution instance.

This prevents a prior root-compromised guest from harvesting credentials later
injected for another run. Root can still read all credentials deliberately
delegated to its own group, which is why Host brokers, group-wide ceilings and
short-lived grants remain necessary. Source data selected for a later run is
still untrusted workload input; rebuilding does not certify the code as safe.
Same-workspace write ownership uses existing workspace leases.

Per-instance transitions serialize with an async ownership lock and durable compare-and-swap revision. Do not hold parking_lot guards across `.await`. Record intended operation before external side effects, preserve CLI/process identity, then commit observed outcome. After a Host crash, inspect only resources bearing verified Cognia ownership and reconcile operations before accepting new calls.

Transport disconnect is not permission to retry mutations. Stable `operationId` deduplicates calls; reads can retry, and mutation retries require an existing receipt. If a guest applied a write and died before acknowledgment, inspect expected revision/hash or return `outcome-unknown`. Process launches with uncertain outcomes are not automatically replayed.

An active job's Host/backend/binding stays frozen even if the controller selects another Host. Switching environments drains or cancels old work, exports state and creates a new generation; it does not mutate the old binding. Revoked generations fail at Host dispatch and guest session entry. Offline operations remain pending on their owning Host, with no automatic local fallback.

This freeze also applies to `AgentExecutionHandle` and its IPC/control port: capture the owning Host transport when the session is created, then route interrupt, close, compact, setModel, permission responses, control acknowledgments and event subscriptions through it. Its current global-transport defaults are not safe for isolated sessions. Capture all Agent file/process/terminal ports at the same time; process ownership maps alone do not pin file callbacks or approval events. Host switching creates another view/subscription and never rewires an existing handle.

### One revocation coordinator invalidates active authority, not just future admission

Keep existing permission/approval services as sources of authorization. A
Host-owned coordinator in the existing resource facade records durable
revocation intents and maintains a reverse dependency index from account,
profile, policy and external grants to bindings, queued operations, streams
and delegated credentials. A Host-observed revoke/expiry or permission-floor
change first advances the authorization epoch and fences affected dispatch and
renewal, then updates the owning authorization record and closes affected
bridges. Cross-database updates use a recoverable intent; failure cannot
temporarily reopen authority. Expiration is checked by Host timers and each
operation/renewal, not a guest's clock or callback.

Queued work fails before resource effects. For running work, broker revocation
is immediate at the observed Host boundary; if a guest can retain authority
that the broker cannot remove, terminate/fence the entire affected group or
report the supported expiry-only limit. Revoking broad guest networking under
the initial Lima profile therefore requires VM stop. Verify termination or
quarantine with `outcome-unknown`. Report `authorization-revoked` separately
from `execution-stopped`: the first does not assert the second. External IAM
propagation and Host-down behavior are bounded only by the backend's proven
capabilities; the initial Lima Host cannot promise termination while it is down.

On restart, reconstruct activation/revocation fences and validate current
authorization before recovering channels, renewing credentials or admitting
jobs. Revoking a profile/execution grant never lowers the persistent isolation
floor. A missing/corrupt runtime-policy store is a refusal requiring recovery,
not evidence that the identity has no floor.

### Storage preserves the existing OCI schema; binary rollback has a minimum enforcement version

The current environment database has a strict schema-version check. Bumping it for experimental execution state would prevent an older binary from opening it. Keep existing OCI catalog/approval tables and schema unchanged in the initial rollout.

Add a Host-owned companion database `runtime-executions.sqlite`, managed beside `EnvironmentStore` with versioned migrations. It contains only the new runtime domain:

| Table                        | Key / important constraints                                                                                                                           | Lifetime                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `runtime_profiles`           | profile ID + version; immutable machine artifact/config/policy digests                                                                                | Revoke rather than mutate approved version                               |
| `runtime_profile_grants`     | profile/version + workspace/account + authority; explicit revocation                                                                                  | Execution authorization history; never owns the isolation floor          |
| `runtime_isolation_floors`   | account/workspace identity; required mode, canonical roots, admission epoch, minimum enforcing build                                                  | Persists across grant revocation, feature disable and supported rollback |
| `runtime_policy_transitions` | unique transition ID; activation/revocation/declassification intent, epoch, affected scope and durable stage                                          | Recover before serving execution; terminal audit receipt retained        |
| `runtime_instances`          | instance ID; unique ownership key while not deleted; observed revision                                                                                | Retained through cleanup receipt                                         |
| `runtime_bindings`           | binding ID/generation; execution group, instance incarnation, account/workspace refs, manifest/restore lineage, grant dependencies and lease deadline | Live until drained, then bounded history                                 |
| `runtime_operations`         | owner + operation ID unique; request digest; status/receipt                                                                                           | Proposed 7-day result-free dedupe history                                |
| `runtime_evidence`           | driver/artifact/config/policy/probe digest tuple                                                                                                      | Invalidated on any identity change                                       |

Export history references existing Task Workspace/delivery records, not another blob store. These tables do not own account credentials or task source changes. Existing authorization services decide who can grant/revoke; machine-specific records do not create a second permission model. UI/Dexie caches are projections, not execution authority.

Pre-enforcement binaries ignore this separate database and therefore cannot
preserve its isolation floor. They are **not supported rollback targets** after
opt-in. Drain/stop/export and execution-grant revocation are necessary cleanup,
not authorization to restore legacy Host execution. The supported deployment
and updater path must enforce a minimum floor-aware build and reject a target
that cannot load and enforce the floor, including when its policy schema is
too new. A compatible rollback build keeps the floor active and refuses old
unbound resource commands after restart.

Returning to a pre-enforcement build requires a separate explicit human
declassification decision: drain/fence all affected work, preserve results,
acknowledge the loss of isolation, lower the floor and record the decision
before downgrade. This is not an automatic feature rollback. A trusted Host
administrator can replace software outside the supported updater; resistance
to that administrator is outside this threat model. Keep the floor record and
new-format instance/recovery records for later recovery. Database backup alone
does not restore external effects or authorize restarting unknown-format VMs.

The reverse grant dependency index is reconstructed from persisted bindings
and pending transitions before execution readiness. Its cache is not authority;
loss of the index or a policy-store error stops affected dispatch until rebuilt.

## 12. Secrets and external operations remain explicit Host capabilities

Threat actors include untrusted repository content, model-supplied paths/commands, guest workload including root, stale clients and wrong-account requests. The Host binary, its configured driver, approved provisioning and explicitly trusted Host extensions are trusted. Lima/hypervisor escape is residual infrastructure risk, not a guarantee this broker can eliminate.

Provider and Git credentials stay on the Host. Guest model/Git access uses existing narrow revocable leases and bridges. Management channels expose no general Host filesystem or arbitrary RPC. Even a guest that steals its own lease can access only that workspace/run's approved operation set until expiry. Secret-free identifiers may persist; raw secrets, environment bodies and tool payloads do not enter plan digests/logs.

External grants bind actor/account, run/workspace, resource identity, operations, expiration and policy revision. Granting a browser operation cannot authorize a Host Shell. Localhost is resolved in the target Host/resource context and is never assumed safe because a URL says HTTP. Unattended tasks inherit existing grants and refuse new ones.

All locally derived text returned to a model, embedding or cloud service continues through the existing PII gate. Moving execution into a VM does not exempt file contents or tool output from that boundary. Network interception and PII redaction solve different problems; both remain explicit.

Tauri/Companion commands use existing authenticated execution routing and manifest registration, with narrowly scoped capability/ACL entries. No broad filesystem permission or generic `limactl <user-command>` RPC is introduced. Web/mobile remain static clients of a paired Host and cannot launch VMs directly.

## 13. The product shows where work acts and refuses unavailable guarantees clearly

The workspace execution view displays Host, backend, instance, guest OS, workspace revision, effective filesystem/network policy and lifecycle state. A tool result displays its action location, with an external-resource indicator where applicable. Provider names are secondary information.

For an isolated workspace, the terminal button opens its bound terminal. An independent Host terminal remains available only as a visibly separate resource, subject to its normal permission flow. Editors read/write the workspace binding; adopting results into the source checkout is a separate action.

Required states: unavailable driver, unsupported version, image download/provisioning, ready, offline, capability denied, changed configuration, stale generation, cancellation unknown, export conflict, held work and cleanup retry. Unsupported capabilities show the precise reason instead of a successful-looking fallback. Do not label stop/start as suspend/resume.

UI remains accessible through named controls, keyboard navigation and announced state changes. All new labels, errors, aria text and tool-location strings use split `en`/`zh-CN` next-intl sources and generated-message checks. No new Next.js runtime server is involved.

## 14. Rollout proves one complete workspace slice before broad adoption

| Phase / proposed owner                                     | Work and dependencies                                                                                                                                                                                           | Success / abort                                                                                                      | Rollback                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| P0: contract / Runtime maintainer                          | Add version negotiation, typed routing/locality metadata, fake provider, receipts, identity-wide activation/revocation fences, minimum enforcing build and floors for all old entry points; no isolated cutover | Legacy fixtures unchanged where no floor exists; old/queued unbound workload requests fail under floor               | Disable allocation; preserve floor; only floor-aware binary rollback is supported                                 |
| P1: shared IO / Sidecar maintainer                         | Bind filesystem/search/process/PTY/stdio MCP and Agent callbacks to existing OS/Docker implementation; add Host-RPC/event streaming/cancellation and captured Agent control/event transports; depends P0        | Conformance and cross-route tests pass; no direct Host IO under isolated plan                                        | Keep non-opted sessions legacy; drain bindings and preserve floors; declassification is a separate human decision |
| P2: Lima qualification / Native runtime maintainer         | Managed lifecycle, guest services, revision reconciliation, guest MCP launch profile, fresh per-group instances and Host bridges; depends P1                                                                    | Full tool slice passes on pinned VZ; group-stop effects and Host-crash limits visible                                | Stop allocations; fence groups, export/hold, revoke bridges; preserve floors                                      |
| P3: opt-in experiment / Desktop maintainer                 | Workspace picker, location UI, grant UX, paired Web/mobile and explicit Host-backed CLI adapter; depends P2                                                                                                     | Qualified Rust Host required; Node-only CLI refuses isolated mode; no restricted-egress or crash-safe deadline claim | Turn off new Lima selection; drain groups without lowering floors                                                 |
| P4: restricted-network qualification / Security maintainer | Implement and qualify outer enforcement if restricted network profiles are required                                                                                                                             | Raw-protocol/root-tampering tests prove requested mode; otherwise feature stays unavailable                          | Withdraw evidence and deny new restricted-network allocations                                                     |
| P5: additional backend / Runtime maintainer                | Extend the suite already exercised by Docker and Lima to E2B/Kubernetes; evaluate later machine providers against their own qualified capabilities                                                              | No Lima-specific branch required in tool bodies; old remote semantics unchanged                                      | Backend-specific flag; preserve other members                                                                     |

Three switches have different roles: allocation enablement, isolated-workspace routing and backend qualification. Disabling allocation does not revoke active resources by accident. Revoking a qualification record blocks new bindings and quarantines affected running instances according to policy. No dual execution is allowed during shadow comparison: compare plans, never run a write twice.

### Proposed limits are experiment defaults, not measured performance

Start with one running Lima VM per Host, two retained instances, 2 vCPU / 4 GiB
RAM and a 20 GiB guest disk per instance, configurable within Host admission
budgets. Used or held disks consume retention slots and are not warm templates
for later groups. Check disk headroom before artifact download and export;
reserve recovery capacity as part of admission and block new allocations when
held resources exhaust the budget. Idle shutdown target: 15 minutes without
active leases. The initial 2-hour workload deadline is Host-supervised and may
be explicitly renewed; it is not a hard bound during Host failure with an
attacker-controlled guest. Tasks requiring a crash-safe hard bound are refused
until an out-of-guest watchdog/provider TTL is qualified. Held work is exempt
from automatic destruction, not resource accounting or operator visibility.

Qualification measures cached cold start, first image download separately, warm command latency, Host memory, guest disk growth and export throughput. Proposed targets: cached start p95 <=90 seconds, warm empty command p95 <=500 ms, normal cancellation observed <=5 seconds before escalation. These are hypotheses to validate on a specified Mac/OS/image over at least 20 runs. If they fail, revise budgets/profile or keep experimental; do not invent a speedup claim.

Operations use bounded per-binding queues (initial proposal: 32 pending), independent control priority and a 1 MiB text result cap per stream with truncation flags. Streaming data has backpressure. Resource limits unsupported by a backend cause admission refusal when required.

### Observability leads to specific action

Record `workspace.plan.admitted/refused`, `runtime.instance.transition`, `workspace.operation.started/settled`, `runtime.capability.withdrawn`, `runtime.export.held` and `runtime.cancel.unknown`. Trace IDs can include binding/operation IDs in structured logs; metric labels are limited to backend, operation family, capability code and outcome.

Measure boot/exec/cancel/export latency, pending queue, cleanup age, held instances and stale-generation refusals. Any cross-account access, resource-route mismatch or Host IO under an isolated binding immediately disables new allocations for the affected adapter. Any unknown cancellation quarantines the instance. Cleanup older than 10 minutes or held exports older than 1 hour require an operator-visible action. Do not log file bodies, commands with secrets, raw MCP frames or repository URLs.

## 15. Acceptance tests prove action location, not just tool registration

| ID  | Behavioral acceptance                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Two concurrent sessions on different backends keep their Host, workspace, policy and tool result location after the UI switches active Host; cancellation, model/control commands, approvals and events still address the original sessions                                                                     |
| A2  | Controller-owned UI tools return to the client; workspace calls from that callback still reach the admitted instance                                                                                                                                                                                            |
| A3  | All file read/write/search/edit/patch aliases see guest sentinel content, not a conflicting Host sentinel at the same-looking path                                                                                                                                                                              |
| A4  | Shell/Git/process/LSP helpers either run in the bound environment or are withheld/refused; a direct Host FS/spawn path makes the test fail                                                                                                                                                                      |
| A5  | Workspace terminal and external Agent share the same workspace identity; ACP file and terminal callbacks cannot access Host files                                                                                                                                                                               |
| A6  | Workspace stdio MCP is started in guest and sees guest sentinel; remote MCP requires its distinct external grant                                                                                                                                                                                                |
| A7  | Existing Docker and a native Lima member run the same binding/operation suite without provider branches in tool bodies; fake backend injects capability failures                                                                                                                                                |
| A8  | VZ snapshots, unsupported network modes and unverified pause/cancel never produce enabled/successful capability claims                                                                                                                                                                                          |
| A9  | No mounts/agent sockets/ambient secrets or unrestricted management bridge appear; changed resolved Lima configuration refuses reuse; network tests cover Host loopback, private, metadata, IPv6, raw sockets and guest-root tampering for every claimed mode                                                    |
| A10 | Unpaired Web/mobile with no backend show unavailable execution; paired clients use the owning Host without frontend Node or Next-server assumptions                                                                                                                                                             |
| A11 | Cancellation reaches a descendant tree; lost guest acknowledgment escalates to verified VM stop or `outcome-unknown`, never a false success; saturated/disconnected sidecar-Host streams remain bounded and cannot starve cancel; MCP frames are not truncated                                                  |
| A12 | Kill Host/driver/guest/transport during create, write, export and delete; restart reconciliation neither repeats mutation nor adopts another deployment's VM                                                                                                                                                    |
| A13 | User edits source during guest export; adoption reports conflict; malicious archive paths/symlinks/Git metadata cannot modify or execute outside the approved root                                                                                                                                              |
| A14 | Export/delete failure retains durable held work; cleanup retries only owned resources; releasing one session cannot close another account's resource                                                                                                                                                            |
| A15 | V1 spec/digest and non-opted legacy fixtures remain unchanged; replay actual old file/write/process/PTY/MCP requests without plan fields under an opted-in Host floor and prove refusal; forged manual surface, alternate aliases, symlinks and changed cwd do not bypass it; drain failure prevents activation |
| A16 | Disable feature, drain and roll back to a floor-aware build: old unbound file/process/PTY requests still refuse and recovery records remain. Reject pre-enforcement targets; separately test explicit human declassification before an incompatible downgrade                                                   |
| A17 | Race legacy admissions/queued launches/PTY attachments with activation, then crash mid-drain. No old epoch reaches a resource effect; startup restores the fence before execution readiness                                                                                                                     |
| A18 | Revoke/expire account, profile and external grants during active MCP/Agent/PTY/API work and crash mid-revoke. Queued calls refuse, bridges close, groups stop or quarantine as required, and the persistent isolation floor remains                                                                             |
| A19 | Cancel one job while sibling Agent/PTY/MCP jobs run. VM-stop escalation uses common outcome/reason types for every affected stream, preserves disk, revokes the generation and rejects all old handles after restart                                                                                            |
| A20 | Kill the Host after guest root disables its supervisor. Initial Lima evidence must report no crash-safe deadline and reject a task requiring one; any future watchdog claim must prove the VM actually stops at expiry without the Host                                                                         |
| A21 | Restore/change the Task Workspace revision with a dirty or stopped guest. Drain/export or report conflict; new generation sees the selected manifest, and old editor/MCP/PTY handles cannot operate                                                                                                             |
| A22 | Import a tracked Linux binary fixture plus approved uncommitted files and excluded content. Requested/effective digests and exclusion approval are explicit; export never misclassifies excluded files as guest deletions                                                                                       |
| A23 | Pure Node isolated requests refuse before local FS/process/MCP spawn; a Host-owned protected reference still resolves/refuses when mode is omitted or owner is unavailable; Host-backed CLI keeps control/events on its captured qualified Rust Host                                                            |
| A24 | MCP launch preflight rejects Host-only executable paths, wrong guest architecture, missing runtime and unavailable auth. Qualified packaged server sees guest files; no permanent Host environment credential is copied                                                                                         |
| A25 | A compromised earlier group attempts to harvest credentials of a later/stronger group. A fresh boot disk and new authority prevent reuse; same-group credential visibility is explicitly within its common ceiling, not advertised as per-job root isolation                                                    |

Unit tests belong beside changed source. Rust tests cover admission/state/receipts and guest protocols; sidecar tests cover every tool alias and injected IO; terminal/MCP tests prove real process location. Use fake providers for fault injection but require a real pinned Lima VM for lifecycle/cancel/no-mount acceptance. Linux/Windows claims require their own hosts and are otherwise unavailable.

Implementation validation uses current entry points: `pnpm test` for focused root Jest; `pnpm typecheck`, `pnpm lint`, `pnpm lint:static-export`; split-message edits require `pnpm i18n:build`, `pnpm i18n:build:check`, `pnpm lint:i18n`. Rust packages include `cognia-environment`, `cognia-sandbox-pool`, `cognia-sandboxd`, `cognia-external-agent` and `cognia-terminal`; use scoped Cargo tests and repository Rust architecture checks when touched. Select sidecar/CLI scripts from their current package manifests. Browser UI acceptance uses Playwright plus actual paired Host and static-export checks. Coverage is run locally only if the user requests it; existing CI policy remains unchanged.

No implementation test, benchmark, production build or real VM test ran for this proposal. Document verification consists of source/upstream checks, contract review and Markdown/diagram inspection. The diagrams are text-based and diffable.

## 16. Decisions, review record and evidence remain explicit

| Decision                      | Options and recommendation                                                             | State / consequence                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1: first-phase scope         | Workspace tools together; or include browser/desktop immediately                       | **User selected workspace tools together, external operations explicitly granted**                                                               |
| Q2: Lima realization          | Native VM member; or Docker carrier only                                               | Recommend native member after common ports; Docker carrier is a compatibility experiment and does not meet per-workspace VM semantics alone      |
| Q3: initial network offering  | Explicit experimental `on`; or no Lima execution until outer restricted egress exists  | Recommend explicit `on` experiment only, while every requested `off`/`allowlist` remains blocked; do not change existing defaults to make it run |
| Q4: workspace sharing         | Guest replica with adoption; or live Host project mount                                | Recommend replica/adoption; additional transfer cost buys a clear Host filesystem boundary                                                       |
| Q5: backend extension trust   | Native first-party driver first; or arbitrary plugin lifecycle execution               | Recommend native first-party driver and conformance contract first; expose a provider SDK only after a second backend proves the seam            |
| Q6: schema shape              | Preserve OCI v1 plus machine-native tagged realization; or reuse image fields          | Recommend explicit versioned union; invalid old-client behavior must refuse                                                                      |
| Q7: reusable compute boundary | Persist one VM across independent runs; or use a fresh VM per approved execution group | Recommend fresh group-scoped compute and revisioned workspace persistence; root compromise is not isolated by per-job bearer tokens              |
| Q8: first-phase CLI reach     | Build a Node-native authority immediately; or require an explicit qualified Rust Host  | Recommend Host-backed CLI adapter, with a precise refusal in pure Node mode; standalone Node parity remains separate qualification               |

Q2–Q8 are proposed review decisions, not actions taken or implementation blockers
hidden behind TODOs. In particular Q7 changes compute reuse, not the user's
selected workspace tool scope. The implementation cannot claim support before
its phase gates pass.

| Review                                      | Result                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current topology trace                      | Completed in the linked tool-execution research; no live deployment claims                                                                                                                                                                                                                                                 |
| Existing-contract reuse audit               | Independent source review plus draft review; machine/OCI split, guest FS/PTY gaps, locality, legacy-command floors, captured control/event transports and end-to-end streaming incorporated                                                                                                                                |
| Pinned Lima evidence                        | Independent primary-source review; default networking, cancellation, sync, snapshot and configuration-merge constraints incorporated                                                                                                                                                                                       |
| Structural/security/compatibility checklist | Applied to draft; independent follow-up confirmed all four draft findings addressed in the design; runtime qualifications remain explicit phase gates                                                                                                                                                                      |
| Second adversarial pass                     | Three fresh-context reviews produced ten actionable findings; bounded follow-up corrected two consistency issues, then found none remaining within its scope; the [report](../research/2026-10-20-workspace-execution-adversarial-review.md) records corrections, qualification limits and user-skipped cross-model review |
| Product/security approval                   | Pending human review of Q2–Q8                                                                                                                                                                                                                                                                                              |

Proposed research follow-ups (dates are review targets, not delivery commitments):

| Item                                            | Single owner role         | Proposed DDL | Required result                                                                                        |
| ----------------------------------------------- | ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| Decide Q2–Q8                                    | Cognia architecture owner | 2026-10-22   | Written decision record before implementation                                                          |
| Specify restricted-network backend experiment   | Security maintainer       | 2026-10-23   | Root-resistant outer enforcement candidate and falsifiable probe plan, or explicit unsupported outcome |
| Turn accepted plan into implementation packages | Runtime maintainer        | 2026-10-23   | P0–P2 issues with owning files/tests and no overlap                                                    |

### Sources

- [Tool execution topology](../research/2026-10-20-tool-execution-topology.md).
- [Lima feasibility](../research/2026-10-20-lima-integration-research.md).
- [Pinned Lima backend contract evidence](../research/2026-10-20-lima-backend-contract-evidence.md).
- [Existing contract reuse audit](../research/2026-10-20-execution-contract-reuse-audit.md).
- [Agent execution authority](../../lib/ai/agent/execution/agent-execution-service.ts), [Agent execution contract](../../packages/agent-config-types/src/agent-execution.ts).
- [Session routing](../../lib/sandbox/session-runtime.ts), [tool-surface policy](../../lib/claude/build-options.ts), [controller proxy](../../lib/claude/controller-tool-proxy.ts).
- [Provider set](../../crates/cognia-sandbox-pool/src/providers/set.rs), [runtime contract](../../crates/cognia-sandbox-pool/src/runtime.rs), [strict v1 spec](../../crates/cognia-environment/src/spec.rs), [store migrations](../../crates/cognia-environment/src/store.rs).
- [Guest supervisor](../../crates/cognia-sandboxd/src/serve.rs), [service bridge](../../crates/cognia-sandboxd/src/service_bridge.rs), [terminal process interface](../../crates/cognia-terminal/src/host.rs), [sidecar Host RPC](../../sidecar/src/platform/host-rpc.ts).
- [Task Workspace](../../lib/task-workspace/types.ts), [revision/adoption](../../crates/cognia-task-workspace/src/revision_patch.rs), [Host Agent ports](../../lib/ai/agent/external/host/process-host.ts).
- [ADR-0182](../content/docs/en/adr/0182-a-project-names-the-image-it-runs-in.md), [ADR-0221](../content/docs/en/adr/0221-a-remote-sandbox-is-a-provider-behind-the-same-seam.md), [ADR-0224](../content/docs/en/adr/0224-an-always-on-host-is-a-peer-the-user-brings.md), [egress design](2026-10-17-sandbox-egress-enforcement-design.md).
- Lima [v2.2.1 release](https://github.com/lima-vm/lima/releases/tag/v2.2.1), [pinned shell source](https://github.com/lima-vm/lima/blob/v2.2.1/cmd/limactl/shell.go), [VZ driver](https://github.com/lima-vm/lima/blob/v2.2.1/pkg/driver/vz/vz_driver_darwin.go), [default network](https://github.com/lima-vm/lima/blob/v2.2.1/website/content/en/docs/config/network/user.md), [current upstream threat model](https://github.com/lima-vm/lima/blob/master/.oss-scanner/threat_model.md) (newer context, not a tagged release guarantee), [tagged license](https://github.com/lima-vm/lima/blob/v2.2.1/LICENSE).

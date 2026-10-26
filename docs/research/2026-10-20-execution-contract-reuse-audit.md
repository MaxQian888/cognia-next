# Execution contract reuse audit for Lima

Date: 2026-10-20 (Asia/Shanghai)

Status: source research only. No provider was installed, no VM was started, and no production code or tests were changed. Existing tests below are evidence of intended contracts, not tests executed in this audit. This report supports the generic execution-backend proposal; upstream Lima research is separate.

## Recommendation

Extend the existing Host-owned sandbox provider set, admission, session binding, and integration ports. Do not introduce a second VM pool, second Agent resolver, or second tool implementation. A direct Lima guest can be a complete `SandboxExecBackend` member; it does not have to pretend to be Docker.

The main compatibility decision is workload identity. `EnvironmentSpec` version 1 is a closed, OCI-image-based contract. A direct VM must not accept that spec and silently ignore its requested image. A versioned placement envelope can retain the unchanged V1 OCI arm while adding an explicit machine-native workload arm. Treat the envelope and native-machine spec as new wire contracts requiring capability/version gating.

## Existing ownership boundaries

| Concern                                  | Current owner and evidence                                                                                                                                                                                                                         | Extension guidance                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime/model/Host choice          | `ResolvedAgentExecutionSpec` in `packages/agent-config-types/src/agent-execution.ts:152`, extending the SDK-facing projection in `packages/agent/src/types.ts:62`; `resolveAgentExecutionSpec` and `executeAgentTurn` in `lib/ai/agent/execution/` | Keep `hostRef` the owning Cognia Host. A VM instance is not another Cognia Host or another runtime adapter. Add a frozen environment-binding reference instead of redefining Host resolution.   |
| Session control                          | `AgentExecutionHandle` in `lib/ai/agent/execution/agent-execution-handle.ts`; `AgentSessionControlPort`                                                                                                                                            | Keep cancel/model/steering semantics here. Provider lifecycle is separate from Agent-session cancellation.                                                                                      |
| Resolved workload and policy             | `types/sandbox/environment-spec.ts`; Rust mirror `crates/cognia-environment/src/spec.rs:309`                                                                                                                                                       | Keep project, lifecycle hooks, egress, user, resources, approval and digest semantics with this authority. Extend via explicit version/tag rather than a parallel Lima configuration authority. |
| Admission                                | `SandboxAdmission` in `crates/cognia-sandbox-pool/src/admission.rs:55`; `cognia-environment` baseline/policy/approval/store                                                                                                                        | Host re-admits every placement. UI-selected capabilities and VM labels cannot grant isolation or authorization.                                                                                 |
| Provider selection and runtime ownership | `ProviderMember` / `ProviderSet` in `crates/cognia-sandbox-pool/src/providers/set.rs:40`; `SandboxExecBackend` in `crates/cognia-external-agent/src/sandbox_routing_backend.rs:294`                                                                | Register a native Lima member in this set; reuse provider ownership for all subsequent calls.                                                                                                   |
| Shell and Computer Use binding           | `SandboxSessionRuntime` in `lib/sandbox/session-runtime.ts:172` and `SandboxSessionBinding` under `types/sandbox/`                                                                                                                                 | Extend the immutable per-session-generation binding. Preserve stale-generation refusal, cancelled preflight and cleanup ledger behavior.                                                        |
| Workspace identity and changes           | `WorkspaceRootLease`, `WorkspaceBundle`, turn leases and code snapshots/results in `lib/task-workspace/types.ts`; Rust owner `crates/cognia-task-workspace`                                                                                        | A guest path is a mapping of a logical root, not a replacement for workspace/run identity. Preserve base revision, resulting revision and explicit delivery.                                    |
| External-Agent machine access            | `AgentProcessHost`, `AgentFileHost`, `AgentTerminalHost` in `packages/agent-contracts/src/host.ts`                                                                                                                                                 | Construct ports bound to one admitted environment, with transport and authority captured. Keep integrations backend-neutral.                                                                    |
| Desktop connection lifecycle             | `SandboxProviderAdapter` in `lib/sandbox/lifecycle-contract.ts:127` and adapter registry                                                                                                                                                           | This is the CUA/connection surface, not the task-pool authority. Reuse its typed capability refusal; do not make it a second execution scheduler.                                               |

There is no `packages/agent-contracts/src/execution*` module in this checkout. The contract package owns capability/event/Host-port vocabulary; the execution-policy/spec projection currently lives in `agent-config-types` and `agent`. Avoid creating a third copy under an assumed path.

There are also two unrelated interfaces named `AgentExecutionEnvironment`:

- `lib/ai/agent/execution/resolve-agent-execution-spec.ts:217` describes resolver facts such as sidecar, Tauri/headless/paired Host availability.
- `lib/ai/agent/execution/local-tauri-environment.ts:38` describes Team environment preparation, child lifecycle, interactive surfaces and evidence collection. Its current production implementation is `createLocalTauriExecutionEnvironment`, instantiated directly by Team paths.

Neither is an existing generic backend registry. The Team adapter is a useful consumer of a bound environment service; resolver facts are not a VM lifecycle interface. Keep their meanings distinct in a proposal.

## Stable seams worth extending

### Host provider set and process plane

`ProviderMember` accepts independent `Arc<dyn SandboxExecBackend>`, `Arc<dyn SandboxDriverStatus>` and optional `Arc<dyn SandboxRuntimeControl>`. `ProviderSet` routes later operations by process owner, tracks bridge ownership, and translates composite hosted-tool leases to provider-specific lease ids. This already permits a complete non-Docker driver.

The narrower `RemoteProvider` in `crates/cognia-sandbox-pool/src/remote/mod.rs:154` combines `SandboxDockerApi` and `RemoteProvisioner`, specifically to reuse `DockerSandboxBackend`. `ProvisionRequest` requires pinned OCI images, bundle provisioning, labels, egress, size and a supervisor. That is suitable for Kubernetes/E2B or an OCI runtime inside a VM; it is not a generic machine-provisioning contract.

`SandboxPlacement` is currently a closed tagged enum with only `Container`, carrying sealed spec, mandatory-isolation flag, hosted-tool leases, optional provider and optional remote Git workspace. A new placement kind must extend the parser, routing, audit projection, admission, provider selection and TS mirror together. An older Host refusing unknown fields/kinds is the correct behavior.

### Guest supervisor and bridges

`cognia-sandboxd` already provides process stdio framing, health, signalling, host-renewed process leases, disconnect descendant cleanup, and authorized port tunnels. See `crates/cognia-sandboxd/src/serve.rs`, `src/main.rs`, and `tests/persistent_runtime.rs` (`a_disconnected_exec_removes_its_agent_and_background_descendants`, `authorized_port_tunnel_preserves_binary_streams_and_tcp_half_close`).

`service_bridge.rs` provides bounded loopback binary multiplexing and lease expiry; its egress form validates generation and policy digest. Reuse transport/framing/lifetime ideas for a fixed SSH-stdio control connection. The current supervisor is not a complete filesystem or PTY server: those operations require a versioned protocol extension and conformance tests.

`ToolHostService` (`runtime.rs:93`) already carries agent id, owner session id, origin device id, lease id and generation. Its live authorization closure is Host-only and skipped by deserialization. `ToolHostBridge` uses an opaque bridge id, not a caller-chosen arbitrary target. Preserve these constraints for external-service grants.

### Filesystem

`AgentFileHost` already supports bounded text/binary reads and writes, delete, immediate file listing, and path containment. It needs narrowly named search/list/stat/versioned operations for the broader workspace tool set, rather than generic arbitrary RPC.

The app adapter in `lib/ai/agent/external/host/file-host.ts` currently delegates to `agent-transport` at call time. Reuse the port contract, but capture the session's admitted environment in its implementation rather than resolving a global active target for every file call.

`crates/cognia-files/src/files.rs` contains the actual confinement primitives (`resolve_confined_workspace_path`, symlink-final-component refusal), workspace text/binary/chunk/versioned reads, search, and workspace mutation operations. These are reusable guest-side primitives without copying tool schemas or tool bodies into Rust. `crates/cognia-files/Cargo.toml` defaults to no Tauri dependency; `tauri-host` is optional, so guest reuse does not require shipping Tauri. Do not expose the whole companion filesystem dispatcher in the guest: it also includes Host administration, task registry, snapshot handoff and broad Host-origin operations.

The Host must derive allowed guest roots from an admitted lease. A caller's `allowedRoots` array alone is not authority. Preserve sensitive-path checks, realpath checks and byte limits on both Host and guest boundaries.

### Terminal and PTY

`AgentTerminalHost` (`packages/agent-contracts/src/host.ts`) already covers session ownership, create/output/write/kill/release/wait and session cleanup. It does not currently expose PTY resize or attach/replay semantics needed by the full terminal UI. Its app implementation (`lib/ai/agent/external/host/terminal-host.ts`) currently delegates to native ACP terminal commands and advertises availability through current Host state.

For terminal UI, reuse `HostedTerminalProcess` in `crates/cognia-terminal/src/host.rs:386`: write, resize, kill, liveness, replay, flow pause and optional local PID. `TerminalHost` already owns controller leases, attachment roles, replay gaps, flow control, device revocation and audit. A guest-backed concrete process adapter can retain these Host controls; it needs a supported registration/spawn path, not a second terminal manager. A guest process must report no local PID, and SSH control-process termination alone is not proof of guest process-group termination.

The desktop terminal-host service's keychain bootstrap (`terminal_host_service.rs`) is not a guest credential mechanism to copy. The Host can retain user-facing authentication while the VM connection gets an independent pinned endpoint and bounded per-instance grant.

### Ports, browser and artifacts

`RuntimePort` and `SandboxRuntimeControl::{list_ports,port_allowed,open_port}` already restrict access to admitted workload ports and check runtime incarnation. `WorkspacePortLease` (`lib/task-workspace/types.ts:243`) is a separate Host-owned port-block allocation keyed by namespace and subject. Keep these two leases distinct: a preview grant authorizes an actual running instance, while allocation does not prove that an endpoint is that instance.

`services/workspace-runtime` is an existing browser runtime with bearer authentication, browser controller leases and quarantined browser-file transfer (`file-bridge.mjs`). It is not a general FS/PTY daemon. `WorkspaceRuntimeLocator` / `WorkspaceRuntimeClient` in `crates/cognia-external-agent/src/workspace_runtime_backend.rs` are useful endpoint/client patterns if browser support is added later; do not deploy the browser runtime just to implement a VM shell.

Workspace bundle/turn leases, code snapshots/results and sandbox delivery records already exist. Lima should reuse these for revisioned input/output and recovery instead of adding a second artifact ledger. The guest needs explicit transfer/publication; keeping a VM alive is not successful result delivery.

## Compatibility traps and required decisions

1. **OCI workload versus native machine.** V1 requires `image: SpecImage`, whose only arms are registry OCI image and locally built Docker image. `bundle.digest` is also an image digest. V1 validation has `version == 1` and `deny_unknown_fields`; `workspaceFolder` is confined under `/workspace`. A machine template/disk digest cannot be stuffed into these fields. Preserve V1 unchanged as an OCI arm; add a native-machine workload/spec arm, or actually run the specified OCI image in the guest.
2. **Digest and approval compatibility.** `EnvironmentSpec.compute_digest` hashes canonical JSON excluding only `specDigest` and `explain`; absent optionals must remain omitted, not `null`. `protocol/environment-spec-fixtures.json`, Rust spec tests and the TS project-environment tests pin both spec and runtime-field digests. New machine/placement content needs its own versioned canonical digest and approval binding; old approval cannot authorize an unbound boot machine or mount policy.
3. **Isolation means execution topology.** A shared Lima VM with several native workload processes is not a VM boundary between those workloads. VM-level attestation needs per-isolation-domain VM identity; shared-VM/container execution needs the inner tier and carrier tier represented separately.
4. **Local versus remote is overloaded.** `ProviderView.remote` currently derives from `limits.is_some()`, and `default_remote` rejects provider id `local`. A managed local VM needs limits without being called a remote cloud. Introduce explicit locality metadata while preserving old wire clients.
5. **Workspace supply is also overloaded.** `SandboxPlacement::Container.workspace` is remote Git-only; local driver refuses it and mounts the Host checkout. A guest-owned workspace should use explicit clone/snapshot/import transport and a logical-root-to-guest-path mapping. Do not use arbitrary shared home mounts to avoid defining transfer semantics.
6. **Snapshot methods are Docker-shaped.** `SnapshotRuntimeLease` currently contains a `Weak<DockerSandboxBackend>` and container id; snapshot image methods are image-named. Lima can initially return unsupported for unverified snapshot capabilities. Later generalization must separate disk checkpoints, workspace checkpoints, process pause and memory resume. Current four capability bits already encode that distinction.
7. **Mutable active Host is unsafe for a frozen environment.** `lib/tauri/transport-routing.ts` holds `activeRemote` and selects at invocation time; subscriptions rebind on Host switch. `installed-host.ts` is a process-wide shell installation, not a per-session VM registry. Keep existing UI behavior, but bind execution resource ports to a captured Host + provider + instance + generation + lease. Never implement parallel VM sessions by swapping a singleton before a tool call.
8. **Controller proxy is not confinement.** `canProxyRemoteToolCall` checks whether a controller round trip is supported. The event's origin-device targeting decides which client replies, but the handler may access that client's resources. External browser/desktop/service grants must be separately admitted and recorded; a compatible proxy does not grant Host filesystem access from an isolated run.
9. **Tool schema neutrality is already solved, tool locality is not.** `sidecar/src/tools/kernel/define.ts` is engine-neutral but has no required placement/effect declaration. Add explicit bound-resource requirements alongside this existing definition/registry seam and preserve adapters. Unknown/unported resource tools fail closed in isolated mode. A category label, MCP annotation or tool name is not an execution proof.
10. **Native SDK tools bypass a custom filesystem port.** Disable native Host filesystem/process tools for isolated sessions unless the SDK supports the exact bridge semantics; expose bridge-backed replacements for read/search/write/shell. In contrast, a whole external Agent launched inside the admitted guest can use its own native tools against that guest.
11. **Credentials and policy remain Host-owned.** Reuse `AgentOutboundGate`, `AgentLaunchEnvironmentResolver`, approval policy and diagnostic redactor from `agent-contracts/host.ts`. Guest native Agent credential injection must use scoped gateways or explicitly approved short-lived credentials. Broad model/provider keys must not follow a copied Host environment.
12. **Process/lease semantics need real fencing.** Existing process id ownership, cancellable creation, bounded group kill, supervisor lease expiry and per-generation cleanup cannot be replaced with `limactl shell` returning a string. Define streaming cancellation, guest PGID cleanup, disconnect behavior and stale generation refusal before exposing capability flags.

## Minimal implementation seams for the proposal

1. Extend the existing closed placement grammar and Host feature contract with a versioned environment-binding envelope. Preserve the V1 OCI arm and add native machine realization only with explicit semantics and digest/approval coverage.
2. Implement a complete Lima provider member in `cognia-sandbox-pool` behind `ProviderSet`, reusing admission, status, owner routing and delivery. Keep boot-machine settings private to the Host provider configuration and bound into admitted placement identity.
3. Extend the guest supervisor with narrow FS/process/PTY operations over a fixed framed channel. Reuse `cognia-files` and terminal primitives, not the full Host RPC surface or copied TS tool handlers.
4. Create session-bound implementations of existing process/file/terminal ports. Extend `SandboxSessionRuntime` generation fencing and publish a binding receipt for ordinary workspace tools as well as `sandbox_*` calls.
5. Adapt sidecar core tool handlers to these ports. Disable unported direct Node FS/child-process paths and native SDK bypasses for strict isolation. Launch the complete external Agent in the same guest identity.
6. Require separately named external grants for controller/browser/desktop/HTTP MCP/tools. Audit logs and UI must show owning Host, actual resource target, guest generation, grant and degradation reason per call.

## Existing regression anchors to retain

- `crates/cognia-environment/src/spec.rs`: `protocol_fixtures_match_the_typescript_digests`, `unknown_fields_are_refused_on_the_way_in`, `optional_runtime_fields_preserve_old_wire_and_validate_new_values`.
- `crates/cognia-sandbox-pool/src/admission.rs`: `recheck_reads_fresh_revocation_without_recording_an_execution`, `local_image_requires_exact_host_record_project_and_source`.
- `crates/cognia-sandbox-pool/src/providers/set.rs`: `a_spawn_goes_to_the_member_its_placement_names_and_stays_there`, `task_shells_go_to_the_member_their_placement_names`, `ports_are_listed_from_every_member_and_opened_on_the_owning_one`.
- `crates/cognia-external-agent/src/sandbox_routing_backend.rs`: provider/placement wire tests, fallback fault/refusal tests, `aborting_a_routed_creation_releases_the_id`.
- `lib/sandbox/session-runtime.test.ts`: immutable bindings, superseded generations, adapter-only dispatch and release failure behavior.
- `lib/ai/agent/external/host/{file-host,process-host,terminal-host}.test.ts`: existing integration-port behavior.
- `crates/cognia-sandboxd/tests/persistent_runtime.rs`: process lease expiry/renewal, disconnect cleanup, binary port tunnel, workspace-alias task execution.
- `crates/cognia-terminal/src/host.rs`: controller takeover, replay gap, device grant, flow pause and detached-session lifetime tests.
- `lib/ai/agent/execution/{agent-execution-service,agent-execution-handle,local-tauri-environment}.test.ts`: frozen resolution, capability refusal and lifecycle/evidence semantics.

New conformance tests must add: same logical file observed by read/search/write/shell/PTY/native Agent/stdio MCP; Host marker inaccessible; stale generation and forged lease refusal; concurrent sessions unaffected by UI Host switch; cancellation kills guest descendants; Host crash and VM restart revoke old channels; oversized/binary/symlink transfer; egress enforcement; result export before deletion.

## ADR alignment

- ADR-0182 remains the workload/admission/digest authority; direct native machine execution requires an explicit compatible successor arm.
- ADR-0183 keeps the bundle and supervisor separate from the user's workload. Moving the entire sidecar and model keys into a VM is unnecessary for this proposal.
- ADR-0221 already supplies one provider set behind one routing seam; a native member is permitted at that level even though its shared Docker-driver adapter is container-shaped.
- ADR-0224 keeps the owning Host authoritative for unattended work, placement, secrets, code supply and delivery.
- ADR-0217 keeps vendor integrations behind neutral machine ports. Provider implementation must not leak Lima-specific branches into every integration package.

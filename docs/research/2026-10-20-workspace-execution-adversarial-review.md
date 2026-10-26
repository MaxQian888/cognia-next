# Second adversarial review of workspace execution and Lima

Date: 2026-10-20 (Asia/Shanghai).

Artifact: [workspace execution proposal](../plans/2026-10-20-extensible-workspace-execution-and-lima.md).

Reviewed baseline SHA-256:
`165350b6a229647a5234c2535bf6ca66ec24d9dc3fb4820d44972d3269e120b4`.
Proposal line numbers below refer to that baseline, before this revision.

Scope: three independent fresh-context, same-model read-only reviews covering
authorization/activation, data/lifecycle, and transport/integration. Their
findings were checked against the artifact and owning source. Cross-model
review was offered under the doubt-driven skill; the user selected skip and
continue revising. No external CLI/model was invoked for cross-model review.

Claim under test: an isolated workspace preserves its admitted resource
location and authority across old commands, Host switches, reconnect, restore,
revocation and failure, while supporting replaceable backends. This claim is a
proposed contract, not verified production behavior.

## Verdict: the previous draft had ten actionable design gaps

Six P1 and four P2 findings were accepted as valid and actionable. They concern
the proposed architecture, not ten established vulnerabilities in current
production. All ten are addressed by amended design contracts; none is claimed
fixed in implementation. Real runtime/security acceptance remains open.

| ID  | Priority | Baseline location                              | Failure scenario / missing contract                                                                                                                                            | Design disposition                                                                                                                                                                                                                                                                   |
| --- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | P1       | Section 11, line 349; A16                      | Old binaries ignore the database containing isolation floors; stopping VMs and revoking execution grants would allow legacy Host execution again after rollback                | Separate durable floors from grants; establish a minimum floor-aware rollback build; reject incompatible automatic downgrade. Pre-enforcement downgrade needs explicit human declassification. A16 now tests post-rollback old commands                                              |
| R2  | P1       | Section 6, line 202                            | A legacy request can pass admission after drain enumeration or launch after floor activation; database transactions do not fence pending resource effects                      | Durable identity-wide `activating` barrier before drain; admission epochs checked immediately before effects; drain queued/in-flight/live resources; restore fences before startup readiness. A17 covers race and mid-activation crash                                               |
| R3  | P1       | Sections 5/11/12, lines 143–145, 328, 341, 357 | Grant revoke/expiry updates admission state without necessarily invalidating active bindings, long-lived bridges or queued work                                                | Single resource-facade revocation coordinator, reverse dependency index, durable intents/epochs, broker closure and group termination/quarantine. Floor survives revocation. A18 covers active revoke, expiry and crash                                                              |
| R4  | P1       | Section 14, line 388; sections 8/11            | Root disables the guest supervisor and the Host dies; a guest timer cannot enforce the claimed two-hour runtime bound                                                          | Advertise initial Lima deadlines only as Host-supervised, `hostCrashSafeDeadline=false`; reject hard-lifetime requirements without an independently qualified out-of-guest watchdog/provider TTL. A20 proves advertised behavior and future hard-deadline claims                     |
| R5  | P1       | Section 9, lines 289–291; section 11, line 322 | Cancelling one Shell escalates to VM stop and also kills Agent, PTY and MCP siblings, leaving their outcomes and bindings undefined                                            | Instance-wide cancellation barrier, revoke generation/renewals, settle or mark all attached operations unknown, preserve disk and require new admission. A19 covers sibling disruption and stale handles                                                                             |
| R6  | P2       | Section 10, lines 295–303; section 11          | A persistent guest keeps later/stale files after Task Workspace restore or source revision replacement, because only initial import and export were specified                  | Track source/effective/guest/export revisions and restore lineage; compare on acquire/reconnect; drain/export or conflict before atomic revision install under a new generation. A21 covers dirty/stopped guest restore                                                              |
| R7  | P2       | Section 10, line 297                           | Blanket exclusion of native binaries removes legitimate tracked ELF tools/test fixtures, changing the selected revision and potentially appearing as deletions on export       | Preserve approved tracked bytes/modes regardless of binary type. Policy exclusions produce explicit requested/effective manifests and approval/refusal; do not interpret omitted projection entries as guest deletions. A22 covers binary fidelity                                   |
| R8  | P2       | Sections 4/6/8, CLI scope                      | A Node standalone CLI cannot reach a new Rust-only pool by registering event forwarders; its Host-RPC map lacks the resource authority                                         | Specify a qualified Rust Host-backed CLI/controller adapter in P3; pure Node mode returns `runtime_host_required` before any local resource fallback. A23 covers both paths                                                                                                          |
| R9  | P2       | Sections 6/8, stdio MCP                        | Host command paths, macOS binaries, dependency runtimes and secret-bearing MCP environment cannot simply be launched in an ARM Linux guest                                     | Approved versioned guest MCP launch projection: artifact/runtime/architecture/cwd and auth requirements, broker or explicitly delegated ephemeral credentials, precise refusal for incompatible definitions. A24 covers launch/auth preflight                                        |
| R10 | P1       | Sections 8/11/12, lines 252, 322, 355–357      | Earlier or parallel guest root in a persistent workspace/account VM can harvest a later run's stronger bearer credentials; per-job IDs/TTL do not isolate a shared root domain | Fresh instance/disk per independently approved execution group; group-wide capability ceiling; fresh group for independently scoped/narrower infrastructure authority. Persist revisioned workspace data, not guest system/login state. A25 covers cross-group credential harvesting |

## Owning source supports the failure models

- R1–R3: [Host surface admission](../../crates/cognia-companion/src/host_surface_gate.rs)
  fast-passes the current single-user execution path and describes admission,
  not active-job revocation. [Remote execution](../../crates/cognia-companion/src/remote_execution.rs)
  performs authorization separately from later asynchronous dispatch.
  [Environment approval revoke](../../crates/cognia-companion-rpc/src/rpc/environment.rs)
  updates the approval store and audit; it is not evidence of an active group
  teardown. Reusing these services therefore needs the proposed lifecycle fences.
- R4/R5: [sandboxd supervisor](../../crates/cognia-sandboxd/src/serve.rs)
  authenticates Unix peers by guest UID and owns in-guest renew/expiry/signal
  logic. Guest root can interfere with those facilities. This does not prove
  out-of-guest expiry or independent sibling isolation.
- R6: [Task Workspace service](../../crates/cognia-task-workspace/src/service.rs),
  `restore_run_snapshot`, clears and materializes its Host execution root.
  The review found only a test caller for that method: this finding preserves
  an existing contract, rather than asserting a currently wired UI regression.
- R7 follows directly from the baseline proposal's blanket binary exclusion;
  selected source revisions can legitimately include executable binary fixtures.
- R8: [CLI stdio transport](../../cli/src/runtime/stdio-transport.ts)
  explicitly answers a small Host-RPC handler map and rejects unsupported
  methods; [CLI external host](../../cli/src/runtime/external/host-branch.ts)
  provides Node-native resource operations, not a Rust provider pool.
- R9: [MCP transport projection](../../sidecar/src/mcp/client/tools.ts)
  accepts command/args/env/cwd; this is transport configuration, not guest
  package, architecture or credential qualification.
- R10: [guest gateway setup](../../crates/cognia-sandboxd/src/gateway_task.rs)
  injects managed gateway bearer credentials into the guest process environment.
  That is appropriate for an approved trust domain, but does not isolate its
  jobs from that domain's compromised root. Short TTL limits time, not another
  root process's ability to read a live token.

## The corrected proposal makes three material trade-offs visible

1. **Persistent source state, disposable compute across independent authority.**
   A workspace remains reusable through selected revisioned data. A used VM is
   not reused for another execution group with independent or stronger grants.
   This increases provisioning/import cost; performance targets remain measured
   qualification work, not an asserted result.
2. **Supported rollback preserves policy, not merely readable databases.**
   Old OCI storage can remain compatible while a pre-enforcement application
   build is still an unsupported downgrade. Lowering the floor is a separate
   explicit decision, never a side effect of feature disable or grant revoke.
3. **Unsupported guarantees are rejected.**
   Initial Lima does not claim restricted egress or a hard deadline while the
   Host is down. Node-only CLI and incompatible MCP definitions cannot silently
   execute on the Host just to keep a turn running.

## Acceptance and verification status

The proposal now contains A1–A25. A16 was strengthened; A17–A25 add activation,
revocation, instance-stop effects, deadline provenance, revision transitions,
transfer fidelity, CLI authority, MCP launch and execution-group isolation.

Verification for this task is limited to source-backed review, proposal
consistency, local links, Markdown fences and formatting. No production code,
configuration or dependency was changed; no application tests, real VM,
benchmark, deployment or runtime security acceptance ran.

## Focused follow-up reconciliation

A fresh-context second cycle checked R1–R10 closure and immediate contradictions.
It found two additional P2 consistency issues, both accepted and corrected:

- The P1 rollout row still said to lift floors after draining. It now preserves
  floors; lowering policy requires the separate human declassification decision.
- VM-stop escalation introduced a terminal outcome absent from the shared
  result schema. It now uses `cancelled` with typed `reason: "instance-stop"`
  after verified stop, or `outcome-unknown` if stop cannot be established. A19
  explicitly requires the common result contract.

The reconciliation also clarifies the R8 assurance boundary: supported clients
must resolve Host-owned references through that Host even when a mode is
omitted. Owner unavailability cannot cause a local fallback. A23 covers both
cases. Arbitrary independently user-launched programs against local paths are
outside the Host-mediated floor guarantee, not silently protected by it.

Review cycle accounting: cycle one was the three-way review; cycle two was the
bounded amended-artifact follow-up. Cycle three checked the two consistency
corrections and the immediate CLI/A23 assurance boundary, and reported no
remaining substantive issue within that scope. The bounded review stops here;
this is not a claim that the whole architecture is proven secure. Cross-model
review was explicitly skipped by the user. Runtime qualification remains open.

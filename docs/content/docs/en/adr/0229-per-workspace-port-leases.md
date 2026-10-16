---
title: "0229 — Per-workspace port leases"
description: "The execution Host assigns a durable port block to each physical workspace root, injects it at process launch, and exposes read-only status and explicit release in Settings."
---

# ADR 0229 — Per-workspace port leases

**Status:** Accepted
**Date:** 2026-10-16
**Amends:** ADR-0111 (managed workspace lifecycle and policy)
**Related:** ADR-0031, ADR-0059, ADR-0088, ADR-0144, ADR-0182

## Context

The W4 workspace gap is port allocation. Isolated directories and Git
worktrees do not isolate the host network: two development servers can still
both try to listen on port 3000. The managed workspace registry already owns
execution roots and lifecycle, but desktop session folders and user project
checkouts also launch processes and need the same contract.

The binding decisions are recorded in
`docs/plans/2026-10-16-workspace-port-allocation-design.md`, under
“Decisions (2026-10-16)”. This ADR records those decisions, the committed
allocator and execution integration, and the Settings and read-only UI contract.
Acceptance of this decision does not imply a live desktop, container or remote
runtime acceptance test.

## Decision

### 1. A physical execution root owns a block

Managed registry workspaces, desktop session folders and user project checkouts
all participate. A canonical physical root has one lease per namespace; several
aliases or subjects referring to that root share the block. Separate worktrees
that happen to share a source repository remain separate execution roots.

The ledger is in `task-workspaces.sqlite`, with `workspace_port_leases`,
`workspace_port_subjects` and recorded root aliases. Subjects are `registry`,
`desktop-session` and `project-root`. Host-discovered checkouts use the last kind
with a `root:<canonical-path>` key; this is distinct from a frontend project ID.
Removing one subject reference does not discard a block still referenced by
another subject.

`WorkspaceLifecyclePolicy` defaults to `portRangeStart: 41000`,
`portRangeEnd: 48999`, and `portBlockSize: 10`: 800 blocks. Serde defaults keep
old saved policies readable. The range is inclusive. Validation requires integer
values, start at least 1024, end at most 65535, start no greater than end, and a
positive block size that fits in the range. Capacity is
`floor((end - start + 1) / blockSize)`.

Changing this policy affects only new allocations. Existing leases retain their
numbers, even if the new range no longer contains them; diagnostics report that
condition instead of silently moving a running server.

### 2. SQLite serializes allocation; probes do not reserve sockets

The execution Host is the authority. Allocation runs inside SQLite
`BEGIN IMMEDIATE`, so different processes using the same ledger serialize their
allocation decisions and cannot allocate overlapping blocks. A frontend never
implements its own allocator.

Each candidate port is probed on IPv4 and IPv6 loopback and wildcard addresses,
with `SO_REUSEADDR` disabled. Unsupported IPv6 is handled explicitly. A block
with a bound port is skipped. When allocation would otherwise be exhausted, or
an idle release initially sees occupancy, probes may settle for up to 500 ms
at 20 ms intervals; this handles transient inherited probe sockets without
adding that delay to normal successful allocation.

Probe sockets close after checking. The lease is therefore a durable allocation
record, not OS socket ownership. Occupancy discovered later is report-only: it
may be the workspace's own server. Cognia does not kill that process or reassign
its block. Exhaustion returns an explicit error naming `portRangeStart`,
`portRangeEnd` and `portBlockSize`; there is no fallback to port 3000.

### 3. Identity is resolved by the Host, within discovery boundaries

An explicit registry workspace ID wins. Otherwise, canonical cwd is matched
against execution roots by path components, choosing the most specific match,
then against registered external subjects. `source_root` is not an execution
identity.

At an execution boundary only, an unmatched cwd may discover its Git worktree
root. Discovery ignores `GIT_*` environment overrides, does not cross filesystem
boundaries, and excludes bare repositories. It never automatically registers a
filesystem root, the home directory, or an ancestor containing home; those
require explicit registration. Nested repositories and linked worktrees retain
their own roots. Discovery failures and rejected boundaries are diagnostics;
non-Git directories without a registered subject execute without a lease.
Once a root is eligible, an allocation or store failure aborts execution rather
than silently dropping its port environment.

Read-only resolution does not discover, register or allocate. A list view can
therefore truthfully show “Not assigned yet” before the first execution.

### 4. Lifecycle keeps stable numbers until release

New managed workspaces obtain their block before setup scripts. Existing
workspaces obtain one lazily on first execution. Archive retains the lease and
restore reuses it; archive alone is not evidence that a process has stopped.
Delete, prune and provisioning rollback release references through the existing
lifecycle guards. Desktop soft deletion keeps its reference for restoration;
permanent session deletion releases it. Project archive retains references,
while project deletion releases exact recorded matches even if paths are gone.

Boot reconciliation repairs registry links and reports duplicate roots,
overlaps, out-of-range blocks, ambiguous or inconsistent registry links and
missing roots. A missing or offline directory is not automatic permission to
reclaim its block. Explicit release in Settings is the recovery route for idle
archived registry leases and orphan or missing-root external subjects.

Registry release requires `Archived` or `Restorable` and an idle block.
`WorkspaceBusy` and `Occupied` refusals preserve the lease, and occupancy errors
include the ports. Subject release can target a single `leaseId`, so a project
with several roots need not lose every reference. Host-derived `root:<path>`
subjects use recorded root identity; their release does not require the missing
directory to be canonicalized again.

### 5. Trusted environment is applied last at each spawn boundary

The Host supplies exactly these keys:

| Key | Value |
| --- | --- |
| `COGNIA_PORT` | First port of the block |
| `COGNIA_PORT_COUNT` | Number of contiguous ports |
| `PORT` | Same value as `COGNIA_PORT` |

The last port is `COGNIA_PORT + COGNIA_PORT_COUNT - 1`. The trusted overlay is
applied after request, profile, launch and sandbox environment processing, so
model or user environment values cannot replace it. DSH, bot, gateway and
sandbox allowlists preserve these exact keys without granting arbitrary
`COGNIA_*` input. Resolution uses the final host cwd before mapping it into a
runtime path. It does not mutate a process-global environment shared by sessions.

`cognia-core/src/workspace_env.rs` is the provider seam; desktop and
`cognia-server serve` install the implementation in
`cognia-task-workspace-host/src/workspace_env.rs`. The persistent desktop PTY
host receives trusted environment over the authenticated native bridge and
does not open another ledger. Older terminal hosts continue serving existing
sessions. New spawns needing the bridge are refused with a restart instruction;
remote-profile spawns are also refused when the older host cannot resolve their
environment. Compatibility must not silently produce a shell without its lease.

The committed phase 3 spawn map is:

| Process family | Integration points |
| --- | --- |
| PTY, one-shot and headless terminal | `crates/cognia-terminal/src/{session,exec,headless,host_client,host_bridge}.rs` |
| External agents, ACP terminals, DSH and managed gateway | `crates/cognia-external-agent/src/{process,terminal,presets}.rs`; bot filtering in `crates/cognia-exec-sandbox/src/bin/cognia-external-agent-launcher.rs` |
| Workspace-runtime, container and Kubernetes agents | `crates/cognia-external-agent/src/{workspace_runtime_backend,container_backend,kube_backend}.rs`; `services/workspace-runtime/src/supervisor.mjs` |
| OS sandbox and project setup, including its sandboxed branch | `crates/cognia-automation/src/sandbox.rs`; `crates/cognia-companion-rpc/src/project_environment.rs` |
| Docker boot, lifecycle scripts, persistent runtime and task-shell exec | `crates/cognia-sandbox-pool/src/docker.rs`, `docker/{persistent,task_shell,remote_prep}.rs`; `crates/cognia-sandboxd/src/{env,init}.rs` |
| E2B and Kubernetes remote preparation | `crates/cognia-sandbox-pool/src/remote/{e2b/mod,kubernetes}.rs` |
| Sidecar Bash foreground/background, shared exec/spawn, terminal REPL, advanced shell, process lifecycle, LSP and search | `sidecar/src/platform/process/exec.ts` and its callers; `workspace.portEnv` in `crates/cognia-companion-rpc/src/sidecar_runtime.rs` |
| CLI external agents, ACP PTY and OS sandbox | `cli/src/runtime/workspace-port-env.ts`, `external/{node-backend,pty-terminals}.ts`, `sandbox/os-sandbox-exec.ts` |
| Host background jobs | `crates/cognia-jobs/src/supervisor.rs` |

Pro IDE's desktop and headless child-spawn integration is a separate change in
`crates/cognia-codeserver/src/{process,remote}.rs`, tracked by ADR-0088; it is not
part of the committed phase 1–3 evidence above. Its contract is to pass the
workspace environment to child terminals and tasks while keeping code-server's
own infrastructure listener independent of the development-server block.

### 6. Runtime placement reuses the numbers, not host port forwarding

Execution in containers and remote runtimes receives the host root's existing
`host-loopback` lease values inside the target network namespace. Placement does
not allocate a second block. The ledger retains a namespace field for explicit
namespace records, but the execution provider resolves the authoritative host
lease. A host probe does not establish availability inside a remote namespace;
unprobeable namespaces are shown as unknown, never as free.

Trusted `workspace_env` reaches boot lifecycle commands as well as each agent
and task-shell execution. A persistent runtime with different workspace port
values must not be reused. Allocation does not publish or forward ports, modify
approved `forward_ports`, or create a preview URL. SSH targets are out of scope.

### 7. Settings manages leases; workspace views only read them

The Data / Maintenance lifecycle block edits the three port policy fields,
shows capacity, explains that existing leases keep their numbers, validates
before saving and preserves server error text.

A lease management block lists each range, count, canonical path, all subjects,
namespace, currently bound ports and reconciliation or discovery diagnostics.
It distinguishes loading, empty, failed and unsupported states. Bound ports are
observations, not proof of a foreign conflict. Releasing a supported lease is an
explicit user action through `runWorkspaceUserAction`, preceded by a confirmation
that its block may be reassigned. Refusal details remain visible and the list is
refreshed after actions.

Workspace environments, workspace overview roots and artifact project overview
roots reuse a small shared read-only badge. Environment lists use the optional
`portLease` projection; root views use read-only resolution. Unknown occupancy
and an unassigned block remain distinct. Rendering or refreshing these views
never calls an allocating command. English and Chinese strings live in split
next-intl sources; generated aggregates are built from them.

Without a desktop or connected execution Host (standalone web mode), these
Settings controls are explicitly inert and explain that the desktop/host app is
required. The unsupported contract is documented in
the TypeScript type and pinned by a test, rather than masquerading as an empty
lease ledger.

The command surface is implemented in
`crates/cognia-task-workspace-host/src/host_surface.rs`, with TypeScript wrappers
in `lib/task-workspace/client.ts`:

| Command suffix after `task_workspace_port_lease_` | Contract |
| --- | --- |
| `get` | Read one registry workspace lease |
| `resolve` | Read by explicit workspace ID or cwd; never discover or allocate |
| `subject_get` | Read all recorded leases for an external subject |
| `list` | Read leases, every subject, occupancy and diagnostics; no repair or allocation |
| `ensure` | Idempotently allocate or reuse a registry lease |
| `resolve_ensure` | Resolve at execution, including eligible checkout discovery and allocation |
| `subject_ensure` | Register a desktop session or project root and share its physical-root lease |
| `release` | Release an idle archived/restorable registry reference |
| `subject_release` | Release an external subject reference, optionally scoped by `leaseId` |

`task_workspace_policy_get` and `task_workspace_policy_set` remain the policy
authority. Reconciliation is a service lifecycle operation, not a hidden write
in a read endpoint.

## Consequences and known limits

- Stable numbers survive restart and archive, but retained archives consume
  logical capacity until released. Reducing a range does not compact old leases.
- Separate Cognia data directories have separate ledgers and are coordinated
  only by the momentary probe. There remains a bind-after-probe race with other
  applications and those other ledgers.
- Long-running shells retain the environment received at spawn. Changing cwd or
  policy does not rewrite an already running shell's environment.
- Applications must actually read `PORT` or the explicit block keys. Cognia's
  own `pnpm dev` and Tauri dev configuration still use port 3000 and are not
  wired to leases by this work.
- Lease allocation does not stop processes, open firewalls, forward ports, or
  guarantee availability inside a container or remote machine.
- Missing-root and discovery diagnostics support explicit recovery; automatic
  deletion would confuse temporary offline roots with abandoned work.

## Implementation and verification boundaries

The allocator and lifecycle are in `crates/cognia-task-workspace/src/ports.rs`,
`service.rs`, `store.rs` and `types.rs`, with in-file tests. Phases 1–3 are
recorded by commits `98fe2cb4c`, `c6c419097` and `413967d5d`. Host command tests,
`lib/task-workspace/client.test.ts` and `execution-port-lease.test.ts` pin the
read/ensure distinction and frontend subjects. Spawn integration tests pin the
final environment, including error propagation and last-wins precedence.

Phase 4's co-located Settings, hook and view tests must cover validation and capacity,
raw host errors, all subject kinds, occupancy and diagnostics, confirmed release
and refusals, inert web mode, unassigned badges and absence of allocating read
calls. Translation generation, parity and co-located test audits are separate
checks. These checks do not replace two real servers listening in different
workspaces, restart stability, or native/container/remote acceptance runs.

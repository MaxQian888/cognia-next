# Sandbox runtime convergence research

**Date:** 2026-08-24

## Question

How should Cognia converge its existing OS sandbox, E2B workspace, remote CUA
desktop, external-agent container, and persistent workspace runtime without
building another terminal/files/browser/container abstraction?

This note intentionally does not repeat the managed-harness findings in
[`deepseek-harness-lessons-2026-08-13.md`](./deepseek-harness-lessons-2026-08-13.md).
It compares execution-environment identity and lifecycle only.

## Primary-source observations

### Devin: one session environment across user surfaces

Devin presents Shell, IDE, and Desktop/Browser as coordinated views of the
same development session. Shell history, IDE edits, browser state, and user
takeover are session-scoped rather than independently targeted. The useful
lesson is not Devin's UI: it is that a tool invocation should not silently
change machines because another surface has focus.

Source: [Devin Session Tools](https://docs.devin.ai/work-with-devin/devin-session-tools)

### Daytona: sandbox identity belongs to the control plane

Daytona separates interface, control, and compute planes. The control plane
owns lifecycle and reconciliation; the compute plane runs isolated instances;
the in-sandbox daemon exposes filesystem, Git, process, terminal, and computer
use operations. This supports one narrow placement/lifecycle authority while
leaving operation-specific clients intact.

Source: [Daytona Architecture](https://www.daytona.io/docs/en/architecture/)

### E2B: one microVM identity, explicit network and lifecycle facts

E2B models each sandbox as a Firecracker microVM and separates control-plane
placement from the in-VM `envd` process/filesystem services. Current SDK source
also exposes creation-time internet/network options. A caller must therefore
bind to a concrete sandbox identity and must not claim a policy that the
created instance cannot attest.

Sources: [E2B infrastructure architecture](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md),
[E2B JavaScript sandbox options](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/sandboxApi.ts)

### Modal: durable references and explicit termination

Modal exposes a sandbox ID that can be detached, recovered with `from_id`,
reused for later commands, and explicitly terminated. Its documentation calls
out pools of open sandbox IDs as a normal pattern. The transferable principle
is a durable runtime reference with an explicit owner and close operation, not
Modal's SDK surface.

Source: [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)

## Decision for Cognia

Adopt only four common principles:

1. **Consistent identity.** Resolve placement once into an immutable
   `SandboxRuntimeRef`; pass that reference through the existing send/plugin
   envelope.
2. **Truthful capabilities.** Re-read mutable health/capability state before a
   remote operation. Explicit but unavailable targets fail closed.
3. **Explicit lifecycle.** Provider lifecycle calls go through the existing
   `SandboxProviderAdapter`/`runSandboxOperation` contract. Session release and
   plugin deactivation close owned remote instances.
4. **Deep-module reuse.** Keep terminal, editor/files, browser, Task Workspace,
   `ExecBackend`, `ContainerApi`, and `WorkspaceRuntimeClient` at their current
   boundaries. The runtime reference routes; it does not duplicate their APIs.

## Concrete capability boundary

- OS/local remains the default and performs no connection lookup.
- A bound CUA desktop currently attests remote GUI only. Its stored
  `workspaceRead` and `workspaceExec` capabilities are normalized to false;
  the legacy `cua-desktop` shell tier remains readable but unavailable.
- E2B execution may claim only an existing E2B workspace handle. Repeated calls
  for the same runtime reference reuse its sandbox. Configuration generations
  for one session can retain that same immutable workspace identity until all
  owners release; different workspace handles remain isolated. Network mode
  must match the instance's creation fact. The current Git-backed workspace is
  created with internet access because clone requires it, so an offline request
  fails closed instead of pretending egress was disabled. Allowlists and
  CPU/memory limits are rejected until the adapter can attest them.
- Credentials and health are never frozen into `SandboxRuntimeRef`.

## Rejected shapes

- A renderer-wide `execute/read/write/browse` interface: duplicates mature
  components and erases provider-specific semantics.
- A second provider registry: `SandboxProviderAdapter` already owns lifecycle.
- Focused-session routing or session-ID global maps: mutable ambient state can
  redirect an in-flight call after settings change.
- Creating a fresh E2B sandbox for every command: loses filesystem/process
  state and violates the workspace identity users selected.

# Lima integration feasibility

Date: 2026-10-20 (Asia/Shanghai)

Status: Research only. No production implementation, installation, VM launch, configuration change, or runtime acceptance was performed. Upstream documentation was inspected on this date; features must be checked against the eventual pinned release.

Pinned-source amendment (2026-10-20): subsequent inspection of Lima v2.2.1
found that noninteractive `limactl shell --sync` automatically copies changes
back; its review prompt is an interactive behavior. Do not use this option as
Cognia's approval or adoption boundary. Also, VZ snapshot methods are
unimplemented in that release, and no generic Lima pause/resume or verified
root-resistant network off/allowlist contract was established. See the
[pinned backend evidence](2026-10-20-lima-backend-contract-evidence.md).

This separate note records a new dependency evaluation without changing an existing implementation plan.

## What Lima provides

Lima (Linux Machines) manages Linux VMs with automatic host-file sharing and localhost port forwarding. It can run containerd, other container engines, and ordinary Linux applications. It is a suitable candidate for a local Linux execution environment; it is not itself an LLM or an agent framework. [Overview](https://lima-vm.io/docs/)

On macOS, VZ uses Apple's Virtualization.framework, requires macOS 13 or later, and has been the default since Lima 1.0. VZ requires matching host/guest architecture. QEMU can run a foreign-architecture guest, with a documented slow mode; Apple Silicon should normally use an ARM Linux guest. [VZ](https://lima-vm.io/docs/config/vmtype/vz/), [Multi-architecture execution](https://lima-vm.io/docs/config/multi-arch/)

The CLI exposes create/start/stop/delete/list/copy/shell operations. `limactl shell <instance> <command>` executes in a guest. Mounts and forwarded ports can connect workspaces and development servers to a host application. [Command reference](https://lima-vm.io/docs/), [Usage](https://lima-vm.io/docs/usage/), [Port forwarding](https://lima-vm.io/docs/config/port/)

Colima means Containers on Lima and adds container-runtime setup. Consequently, consuming Docker in a Lima/Colima VM and directly managing a Lima VM are different integration choices. [Colima README](https://github.com/abiosoft/colima), [Lima container examples](https://lima-vm.io/docs/examples/)

## Upstream AI integration

Lima explicitly documents both agents inside VMs and agents outside VMs. Since Lima 2.0, the latter can use its MCP tools for guest file reading, writing, and command execution. The documented tool set includes `glob`, `list_directory`, `read_file`, `replace`, `run_shell_command`, `search_file_content`, and `write_file`. This is a possible experiment through Cognia's existing MCP integration, not proof that it satisfies Cognia's sandbox lifecycle contract. [AI configurations](https://lima-vm.io/docs/config/ai/), [External agents](https://lima-vm.io/docs/config/ai/outside/), [MCP tool schemas](https://lima-vm.io/docs/config/ai/outside/mcp/)

## Cognia fit

The following source findings were verified by the coordinating agent in the current checkout:

- `lib/sandbox/adapter-registry.ts` registers `docker:computer-server` and `e2b:computer-server`; there is no registered Lima adapter.
- `lib/sandbox/lifecycle-contract.ts` already defines lifecycle, health, workspace read/exec, and GUI capabilities, with capability gating and no host fallback.
- `crates/cognia-sandbox-pool/src/boot.rs` wraps the existing execution backend with sandbox routing; local Docker is optional.
- `crates/cognia-sandbox-pool/src/docker.rs` advertises container isolation and optional gVisor, not a VM tier.
- `crates/cognia-external-agent/src/container_backend.rs:1715` branches on TCP/HTTP `DOCKER_HOST` and otherwise connects with local defaults. Selecting a Docker context alone is not established to select Lima/Colima's Unix socket; endpoint compatibility requires verification.

These findings suggest three bounded choices:

| Choice                | Value                                                        | Required evidence                                                                                                                 |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Lima MCP experiment   | Evaluate Linux file/command tools using an existing protocol | Tool permissions, workspace boundaries, cancellation, output handling, and end-to-end reachability                                |
| Docker in Lima/Colima | Reuse the existing Docker execution path on macOS            | Docker endpoint discovery, mount path translation, image compatibility, resource limits, cancellation, and cleanup                |
| Direct Lima provider  | Own a VM per workspace or isolation domain                   | Lifecycle adapter, provisioning, execution transport, workspace transfer, health/recovery, port ownership, and garbage collection |

Recommendation: retain Lima as an optional backend candidate. First validate existing Docker support against a user-managed Lima/Colima daemon when container execution is the goal. A shared Docker VM does not create a separate VM boundary for each task. Build a direct provider only if per-workspace VM isolation or full Linux environments justify the additional lifecycle work. MCP is a smaller exploratory route for file/command tools, with a different capability scope.

Adding Lima MCP tools does not automatically reroute or confine Cognia's other host tools. Formal sandbox support must enforce execution placement and policy across the applicable tools, including mounts, credentials, network access, and cancellation.

CLI management belongs in the native Rust/Host layer. The statically exported Web and mobile clients would use a paired execution host; they cannot launch a host VM directly. No runtime Next.js server dependency is needed. These are architectural recommendations, not verified product behavior.

## Security and distribution constraints

- The default host-home mount is read-only. Read-only still discloses readable credentials and documents. An agent profile should expose only its project or use no host mounts. Lima recommends project-only mounts. Its `shell --sync` workflow requires Lima 2.1+, no mounts, and rsync on both sides. Interactive execution offers review, but v2.2.1 noninteractive execution automatically copies changes back. [Usage](https://lima-vm.io/docs/usage/), [AI examples](https://lima-vm.io/docs/examples/ai/), [pinned shell implementation](https://github.com/lima-vm/lima/blob/v2.2.1/cmd/limactl/shell.go)
- The upstream threat model treats the entire guest, including root, as attacker-controlled. Templates, provisioning, mounts, forwarding rules, command arguments, and `LIMA_HOME` are trusted inputs. Cognia should generate controlled profiles, avoid credential/socket forwarding by default, and treat guest output as untrusted. [Threat model](https://github.com/lima-vm/lima/blob/master/.oss-scanner/threat_model.md)
- Port forwarding defaults to localhost, but network access needs an explicit policy. VM isolation alone is not a network-egress policy. Plain mode disables mounts, dynamic forwarding, guest agent, built-in containerd, and SSH-agent forwarding; static forwards and provisioning remain. [Threat model](https://github.com/lima-vm/lima/blob/master/.oss-scanner/threat_model.md), [Plain mode](https://lima-vm.io/docs/config/plain/)
- Base templates can lag security patches. An integration needs image provenance, digests, an update policy, and a pinned supported release rather than arbitrary downloaded templates. [Security documentation](https://lima-vm.io/docs/security/)
- Lima's Apache-2.0 license permits redistribution subject to its conditions, including license and applicable notices. This does not establish the terms of every bundled guest image, QEMU binary, or other dependency. Initial integration should consume a user-installed Lima; bundling requires an inventory of the actual artifacts and their licenses. [Lima license](https://github.com/lima-vm/lima/blob/master/LICENSE), [Installation options](https://lima-vm.io/docs/installation/)

## Acceptance still required

Before claiming support: verify a pinned Lima release on Apple Silicon; execute real workspace read/write/command and preview flows; test timeout/cancellation and stop/delete/restart recovery; prove host-secret exclusion and cross-workspace boundaries; measure cold start, steady-state memory/disk, and cleanup; verify browser/mobile routing through the paired host. No such runtime checks were run for this research.

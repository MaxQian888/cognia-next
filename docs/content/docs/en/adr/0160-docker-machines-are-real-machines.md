---
title: "0160: Docker machines are real machines, and the session follows"
description: "Containers stop being scratch processes: an explicit create/start/suspend/resume/stop/delete lifecycle backed by docker inspect, adoption by stable name, and a bound session's shell and file work running inside the machine under an attested policy."
---

# ADR 0160: Docker machines are real machines

**Status:** Accepted  
**Date:** 2026-08-31  
**Builds on:** [ADR-0020](./0020-computer-use-completeness), [ADR-0143](./0143-device-console)

## Context

`lib/sandbox/` already had the shape of a provider-neutral machine manager: a
`SandboxProviderAdapter` with eleven operations, eleven normalized lifecycle
states, a per-operation forbidden-state table, and a capability matrix whose
`false` entries are a contract rather than a hint. What it did not have was an
adapter that could carry most of it.

Three things were wrong underneath.

**Containers were created with `docker run --rm`.** That makes `docker stop`
destroy the container, which collapses stop and delete into one operation and
loses every file the user wrote inside the machine. The `delete` adapter method
called `client.stop()`, which looked correct only because of `--rm`. A machine
that forgets itself on every stop is not a machine.

**The registry tracked containers in a process-local map and always created a
new one.** Container names are derived deterministically from the connection id,
so a container that outlived an unclean app exit left its name taken and every
later `docker run --name` failed. That connection was permanently unstartable,
and the UI could only show a Docker error.

**The `cua-desktop` shell tier was withdrawn**, with a reason recorded on all
three dormancy axes: a bound desktop proves remote GUI isolation only, so shell
and file work would not be sandboxed.

## Decision

### Containers persist, and are adopted rather than recreated

`--rm` is gone and removal is explicit. `docker inspect` becomes the single
source of truth for lifecycle state, replacing an in-process map that recorded
what we asked for rather than what Docker did. Every entry point inspects the
deterministic name first and adopts what it finds: unpause a paused container,
start a stopped one, reuse a running one, create only a genuinely absent one.

Application exit drops the cached driver connections and leaves containers
running. A machine the user started is expected to still be there next launch.
The cost is that an idle machine keeps consuming resources, which the UI states.

### Suspend is `pause`, never `stop`

`docker pause` SIGSTOPs the container's processes and keeps its memory resident,
so the desktop session survives and resume returns the same machine. `docker
stop` does not, and standing in for suspend with it would report a paused
machine that had silently rebooted. Docker reports a paused container as still
running and a stopped one as not, so the two are distinguishable, and a live
test pins that.

### The withdrawal of `cua-desktop` is lifted by evidence, not deleted

The withdrawal reason was conditional on nothing carrying shell and file work
into the container. `docker exec` does, and this was verified against a real
container rather than argued: `docker exec <id> hostname` returns the container
id and not the host's, and `/etc/os-release` inside reports the image's
distribution on a macOS host. Four ignored-by-default tests keep the claim
checkable.

The tier is still conditional. It requires a bound connection whose provider
actually carries `workspaceExec`, so `cua-cloud` and `lume` are refused exactly
as before, and the tier stays listed-and-unavailable rather than hidden when no
such connection exists.

### Per-call policy is attested, never enforced after the fact

Docker freezes network mode and the cpu and memory ceilings when the container
is created, and `docker exec` cannot tighten any of them for a single command.
A request asking for more confinement than the machine has is therefore refused
with `policy-not-attested` rather than run, following the precedent the e2b
microvm tier already set. Running it would execute under weaker isolation than
the caller believes it obtained, which is the failure the sandbox exists to
prevent.

Host paths are refused or rebased onto the workspace mount, never passed
through. A host path names nothing inside a container, or worse, names something
else. `allowlist` networking is treated as a confinement no container flag
provides, rather than being quietly downgraded to `off` or widened to `on`.

### Capability defaults carry a revision

A stored capability matrix could previously only be narrowed on read. That rule
protects handshake narrowing, where a peer turns out to support less than
advertised, but it also means `false && true` is `false`: a row written before
an adapter existed could never learn that one now does. Every pre-existing
database would have shown the new controls greyed out forever, and only a
freshly created one would have looked correct.

`capabilitiesRevision` separates the two claims. Defaults are the application's
own ground truth and move in both directions across releases, so a row behind
the current revision is recomputed from them. Handshake narrowing stays
per-connection and still only ever removes, within a revision.

## Consequences

- Stopping a machine keeps it and its filesystem. Deleting is the only
  destructive operation, and it is labelled as such.
- Machines outlive the app. An idle one still holds cpu and memory until it is
  stopped.
- Seven new `cua_sandbox_*` commands exist. They are `target: "client"` with
  `transports: ["internal"]`, so they never cross the companion wire and always
  act on the machine running the renderer. `exec` and `read_file` are recorded
  as high risk, because they run arbitrary commands and read arbitrary paths
  inside the machine.
- A session bound to a Docker machine with a workspace mount runs its `Bash`,
  `Read`, `Edit` and `Write` inside it. Without a mount, writable-path requests
  are refused rather than silently retargeted.
- No cloud control plane is integrated. `cua-cloud` and `lume` keep an empty
  capability matrix and no adapter, so every operation on them refuses. The
  adapter registry is the seam a future provider fills.

## Alternatives considered

**Keep `--rm` and narrow the capability matrix to match.** Honest, and much
smaller, but it settles for a sandbox that cannot hold state between runs. The
matrix would have had to drop `stop` entirely and say so in the UI.

**Translate host paths into container paths generally.** Rejected for now. Path
translation without a declared mount is guesswork about which host directories a
machine may reach, and guessing wrong writes somewhere the caller never named. A
single declared mount, with everything outside it refused, is the bounded
version.

**Enforce per-call policy by recreating the container.** Technically possible
and rejected: a `Bash` call that silently destroys and rebuilds the machine it
runs in would lose the session the tier exists to provide.

---
title: "0143 — One console for every machine"
description: "Device management becomes a single fleet view over the placement candidate space: paired devices, remote hosts, workers and this machine as one row shape, with the capabilities, presence and grant detail the old surfaces held but never rendered, and the sandbox and workspace runtimes attached per device."
---

# ADR 0143 — One console for every machine

**Status:** Accepted
**Date:** 2026-08-24
**Related:** [ADR-0136](./0136-cross-device-placement), [ADR-0082](./0082-remote-development-remote-host), [ADR-0028](./0028-sandboxed-execution), [ADR-0060](./0060-attention-and-capture), [ADR-0111](./0111-managed-workspace-registry)

## Context

"Device management" was two surfaces that could not see each other, and both
were poorer than the data behind them.

`components/settings/companion/paired-devices-card.tsx` was a ten-column table
inside one card, scrolling horizontally at 360px tall. It rendered **no
capabilities** — although `pairedDevices.capabilities` has been written on
every connect since ADR-0060 by `lib/companion/capability-reporter.ts`. It
rendered Dexie's durable `lastSeenAt` — although
`lib/companion/device-presence-registry.ts` maintains the live event plane,
attention state and open streams, and says in its own docblock that no surface
renders it. It inferred lifecycle state from `revokedAt` / `pausedAt` —
although `companion_list_devices`, whose doc comment calls it *"the Device
Center's read side"*, returns the host's authoritative `role` and `status` and
had **zero TypeScript callers**. And because
`companion_list_device_grants` answers each grant with an all-of test, a device
holding `agent.run` but not `workspace.write` came back `false` and rendered
identically to a device that had never been granted anything.

`components/settings/remote-hosts/tabs/hosts-tab.tsx` was a bare `<ul>` that
printed the capability list as a wall of badges and the feature manifest as raw
key-value lines.

Meanwhile `lib/placement/` (ADR-0136) had already modelled
`worker | paired-device | remote-host | local` as one candidate space, with
`sandbox` and `workspace` among its dimensions — and nothing produced a value
for either, so `sandbox_mismatch` was a rejection reason no candidate could
trigger. The question "which machines could run this?" had three answers that
could not see each other: the workflow editor filtered remote hosts by
`featureManifest.features["workflow.execution"]`, the teammate binding read
`useFleetSnapshot()`, and `action.mobile.*` sorted paired devices by
`lastSeenAt`.

## Decision

### 1. One row shape, identical to the candidate space

`lib/devices/types.ts` defines `DeviceRow`, whose `ref` **is**
`PlacementCandidate.ref` — the same value, not two ids that happen to agree.
`DeviceKind` is pinned equal to `PlacementCandidateKind` by a compile-time
assertion, so a new kind of machine that can run work fails to build rather
than being silently unshowable.

All derivation is pure. `buildDeviceRows` takes every source as an argument —
paired rows, the host's device list, remote hosts, workers, presence, sandbox
connections, a clock — so the whole matrix of *host reachable / host
unreachable / never reported / mirror disagrees* is reachable in a unit test
rather than only on a paired phone.

### 2. "Never told us" is not "no"

The console is the first surface that had to decide what an unreported device
looks like. It refuses to answer with a column of misses: `absent` means the
device answered and lacks the capability, `expected` means the platform
baseline implies it and nobody confirmed, `unknown` means we have nothing.
When a device has never reported, **nothing** is `absent`.

The same rule governs presence: a remote host that has never been reached
reports `unknown`, not `offline`. Painting the absence of a signal as a
negative answer states facts nobody gave.

### 3. The host outranks the mirror, and a disagreement is shown

The precedence the old card used for its switches — the host's answer when we
have it, the Dexie mirror only as a fallback — now governs lifecycle state as
well, and a disagreement is flagged rather than quietly resolved. A device
suspended through the `cognia-server devices` CLI or the Owner API left the
mirror untouched, so the row read "active" while every call from it was
refused.

`companion_list_devices` also returns the raw capability set, which makes
`partial` derivable without widening the Rust surface. The mirror of
`GrantKind::capabilities()` is pinned against the generated host command
catalog, so a rename fails a gate instead of downgrading every device to
`partial` — a typo that would read as a security regression.

### 4. Runtime support follows the routing rules, not intuition

What a device can tell us about its runtime is dictated by the `target`
recorded for each command in `protocol/companion-commands.json` and dispatched
by `lib/tauri/transport-routing.ts`:

- `cua_sandbox_*` are `target: "client"`, so **sandbox connections always
  belong to the machine running the renderer**. A remote host's sandboxes are
  not reachable from here at all, and an empty list would imply it has none.
- `task_workspace_environment_list` is `target: "execution"`, so it resolves to
  `activeRemote ?? local`. A workspace list is therefore only ever true of the
  **current routing target**, which is why workspaces have a third state,
  `requires-activation`, instead of a flat yes/no. Reading it naively would
  print a remote machine's worktrees under the local device's name.

The sandbox registry is the existing settings surface embedded, not a copy, so
the two cannot drift. The withdrawn `cua-desktop` tier is listed and disabled
with its reason rather than hidden, because a session still carrying that
stored value needs something on screen explaining the refusal.

### 5. The sandbox tier finally reaches placement

`buildDevicePlacement` fills `provides` per dimension, and a shell tier counts
only when it can actually execute: an unregistered microVM adapter makes
`executeSandbox` throw `microvm-unavailable` with host fallback explicitly
forbidden, so advertising the tier would promise an execution guaranteed to
refuse.

`PlacementDimension` gains `host-feature`. It is its own value space for the
same reason `platform` and `agent` are: `HostFeatureId`s are minted by
`lib/platform/host-feature-manifest.ts` and carry a version and an operation
list, so a host `workflow.execution` is not a platform capability and must not
satisfy one.

### 6. Ineligible candidates are shown, not filtered out

`buildDeviceOptions` returns every candidate with a verdict. The workflow
run-on picker now renders the ineligible ones disabled with their typed
`PlacementReason` — the interface half of ADR-0136's visible degradation.

Capacity is deliberately unbounded in this directory. It answers "may this
machine be chosen", and it has no load telemetry for a host or a phone;
claiming a `maxUnits` we cannot observe would reject work over a number we
invented.

## Consequences

- Settings keeps pairing, adding a host and LAN discovery — configuration —
  and links into the console for the fleet. A second list in Settings would be
  a second surface to hold in step, and it is the one that would fall behind.
- `/me/devices` opens the console. `FeaturePageShell` already collapses to one
  column with sheet triggers below `md`, so both shells are served from one
  tree instead of a mobile-only wrapper.
- Every write the paired-devices card made survives in `useDeviceGrantActions`
  with its asymmetry intact: enabling is behind the biometric guard, disabling
  applies immediately, because a user who cannot pass the biometric must still
  be able to take a permission away.
- Locked Use keeps its three-axis dormancy — documented at the type, rendered
  inert and labelled, pinned by a test.

## Not done

- **The teammate execution binding still reads `useFleetSnapshot()`.** It needs
  real `activeTurns` / `maxActiveTurns` to make a dispatch decision, and this
  directory declines to claim capacity. Switching it would trade a real number
  for an invented one.
- **A worker gets no platform capability matrix.** Its enrollment carries
  SecurityStore capability ids, which are a different vocabulary; rendering
  them in the platform matrix would read them wrong.
- **`companion_suspend_device` / `companion_resume_device` remain unused.** The
  console's Pause still writes the deny list through `companion_revoke_device`,
  exactly as the card did. Moving to the canonical `LifecycleAction` vocabulary
  is a behaviour change to the enforcement path and belongs in its own change.
- **Presence does not survive a reload.** `device-presence-registry` is an
  in-process map with no subscription; the console polls it and falls back to
  Dexie's durable `lastSeenAt`, so a freshly-loaded window shows durable
  presence until the first stream reports.

## Amends

- **ADR-0136** — `PlacementDimension` gains `host-feature`, and the `sandbox`
  dimension acquires its first producer. `PlacementReason` is unchanged and
  remains append-only.

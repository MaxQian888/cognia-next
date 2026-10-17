---
title: "0231 — Sandbox snapshots join rootfs and workspace"
description: "Cold Docker checkpoints preserve a stopped root filesystem and a pinned, complete workspace capture."
---

# ADR 0231 — Sandbox snapshots join rootfs and workspace

**Status:** Accepted
**Date:** 2026-10-17
**Related:** ADR-0182, ADR-0183, ADR-0213, ADR-0221, ADR-0229

## Decision

A local Docker sandbox snapshot consists of two immutable artifacts: an image
committed from a stopped container, and a Task Workspace checkpoint of its
host-mounted workspace. A Docker image alone does not contain bind-mounted
files. A workspace checkpoint alone does not contain system packages, global
installs or the container's home directory.

An active agent or task turn refuses capture with `snapshot_busy`. This is a
cold filesystem checkpoint, not process suspension: memory, sockets, tmpfs and
running services are not captured. Restoring starts fresh processes.

The full capture profile includes tracked, untracked, ignored and generated
files, empty directories and file modes. User-declared exclusions are recorded
in the manifest. Exceeding the budget fails capture; it never silently removes
files from the checkpoint. Each checkpoint has its own mandatory Git ref pin
protecting the recorded base from garbage collection.

## Durable ownership and recovery

`task-workspaces.sqlite` owns `workspace_checkpoints`, `sandbox_snapshots`,
`snapshot_artifact_refs` and `snapshot_operations`. The creation journal moves
through `preparing → workspaceCaptured → imageCommitted → ready`. Failures
compensate by removing a committed image and releasing the checkpoint. Startup
recovery reconciles interrupted operations before exposing them as ready.

Images use `cognia-snapshot-<deploymentHash>:<uuid>` names. The ledger records
the immutable image ID; Docker labels never grant access or authorize deletion.
Deployment identity and durable references, rather than user-supplied labels,
determine ownership.

## Fork and restore

A fork creates a new task, workspace, execution root and ADR-0229 port lease.
It restores the recorded commit and checkpoint overlay and creates a container
from the snapshot image. The new runtime receives fresh mounts and admission;
source leases, grants, sessions and egress bridges are not copied. An
allowlisted runtime must receive a new egress lease. Only `postStart` and
`postAttach` lifecycle hooks run again.
The injected agent bundle is recorded by digest and checked before workspace
restoration and subsequent runtime acquisition.

In-place restore is permitted only for an archived, restorable workspace.
Otherwise restore creates a fork. Restoring a checkpoint does not grant access
to its source workspace or broaden network permission.

## Storage lifecycle

`sandboxSnapshotBudgetBytes` defaults to 1 GiB and is separate from the
existing 1 GiB workspace blob budget. Retention defaults to 30 days, with
explicit pinning. A reaper tombstones the snapshot, calls the preview revocation
hook, and removes this deployment's image only when no runtime, fork or
in-flight operation references it. Only then may checkpoint pins and blobs be
released. No operation runs `docker system prune` or deletes another
deployment's image.

The preview revocation hook is the integration point for the separate preview
job. Preview listeners, links and UI are outside phase 1a.

## Provider and host contract

Provider capabilities distinguish `filesystemCheckpoint`, `forkFromCheckpoint`,
`pauseResume` and `memoryResume`. Local Docker supports the first two. E2B keeps
its existing pause/resume behavior; checkpoint forking remains unsupported and
returns a labelled refusal until the provider API has been verified.

The host exposes `sandbox_snapshot_create`, `sandbox_snapshot_list`,
`sandbox_snapshot_get`, `sandbox_snapshot_delete`, `sandbox_snapshot_pin`,
`sandbox_snapshot_fork` and `sandbox_snapshot_restore`. Tauri and Companion use
the same backend authority; the TypeScript client is a transport adapter.

## Validation boundary

Fake Docker tests exercise busy refusal, state transitions, compensation,
recovery, budgets, exclusions, fork isolation and deployment-scoped cleanup.
Real-Docker round trips are explicitly ignored by default and require a local
daemon. A sandboxed check without Docker or socket binding is not evidence of
a successful native-container or preview flow.

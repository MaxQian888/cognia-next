/** @jest-environment jsdom */
import { transport } from "@/lib/tauri/transport-instance"
import {
  sandboxSnapshotCreate,
  sandboxSnapshotDelete,
  sandboxSnapshotFork,
  sandboxSnapshotGet,
  sandboxSnapshotList,
  sandboxSnapshotPin,
  sandboxSnapshotRestore,
} from "./snapshots"

const call = jest.spyOn(transport, "call")

beforeEach(() => call.mockReset())

it("forwards declared exclusions without filtering ignored or generated content", async () => {
  const request = {
    projectId: "p",
    workspaceId: "w",
    provider: "local",
    containerId: "c",
    exclusions: ["secrets", "cache/private"],
  }
  const result = { snapshotId: "s", phase: "ready" }
  call.mockResolvedValue(result)
  expect(await sandboxSnapshotCreate(request)).toBe(result)
  expect(call).toHaveBeenCalledWith("sandbox_snapshot_create", { request })
})

it("uses snapshot IDs for reads and mutations, leaving ownership to the host", async () => {
  call.mockResolvedValue({ items: [] })
  await sandboxSnapshotList("project")
  await sandboxSnapshotGet("snapshot")
  await sandboxSnapshotPin("snapshot", true)
  await sandboxSnapshotDelete("snapshot")
  expect(call.mock.calls).toEqual([
    ["sandbox_snapshot_list", { projectId: "project" }],
    ["sandbox_snapshot_get", { snapshotId: "snapshot" }],
    ["sandbox_snapshot_pin", { snapshotId: "snapshot", pinned: true }],
    ["sandbox_snapshot_delete", { snapshotId: "snapshot" }],
  ])
})

it("forks with new task identity and sends the optional restore target explicitly", async () => {
  const request = { snapshotId: "s", taskId: "new-task", sessionId: "new-session" }
  await sandboxSnapshotFork(request)
  await sandboxSnapshotRestore({ ...request, workspaceId: "archived" })
  expect(call.mock.calls).toEqual([
    ["sandbox_snapshot_fork", { request }],
    ["sandbox_snapshot_restore", { request: { ...request, workspaceId: "archived" } }],
  ])
})

it("preserves labelled busy and provider refusals for callers", async () => {
  for (const code of ["snapshot_busy", "snapshot_fork_unsupported"]) {
    const refusal = { code, message: code }
    call.mockRejectedValueOnce(refusal)
    await expect(
      sandboxSnapshotFork({ snapshotId: "s", taskId: "t", sessionId: "c" })
    ).rejects.toBe(refusal)
  }
})

it("pages through every snapshot instead of truncating the list", async () => {
  call
    .mockResolvedValueOnce({ items: [{ snapshotId: "first" }], nextPageToken: "opaque" })
    .mockResolvedValueOnce({ items: [{ snapshotId: "last" }] })
  expect(await sandboxSnapshotList("project")).toEqual([
    { snapshotId: "first" },
    { snapshotId: "last" },
  ])
  expect(call).toHaveBeenLastCalledWith("sandbox_snapshot_list", {
    projectId: "project",
    pageToken: "opaque",
  })
})

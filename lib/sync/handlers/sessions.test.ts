/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncDelta } from "../types"
import { syncSessions } from "./sessions"

function transportFor(rows: unknown[]): Transport {
  const delta: SyncDelta<unknown> = { rows, deleted_ids: [], next_since: 20 }
  return {
    call: jest.fn(async () => delta) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncSessions managed workspace boundary", () => {
  beforeEach(async () => {
    await getDb().sessions.clear()
  })

  it("marks a managed workspace from another device as missing instead of guessing a path", async () => {
    await syncSessions(
      transportFor([
        {
          id: "s1",
          title: "Remote",
          createdAt: 1,
          updatedAt: 20,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
            managedWorkspace: { availability: "available", localRoot: "/remote/private" },
            projectId: "",
            projectRoot: "/remote/private",
            taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
          },
        },
      ]),
      { since: 0 }
    )

    const context = (await getDb().sessions.get("s1"))?.executionContext
    expect(context?.projectRoot).toBe("")
    expect(context?.managedWorkspace).toEqual({ availability: "missing-on-device" })
  })

  it("preserves a matching workspace's local binding while applying remote metadata", async () => {
    await getDb().sessions.put({
      id: "s1",
      title: "Local",
      createdAt: 1,
      updatedAt: 10,
      executionContext: {
        location: "managedWorktree",
        workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
        managedWorkspace: { availability: "available", localRoot: "/local/root" },
        projectId: "",
        projectRoot: "/local/root",
        taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
      },
    } as never)

    await syncSessions(
      transportFor([
        {
          id: "s1",
          title: "Remote title",
          createdAt: 1,
          updatedAt: 20,
          executionContext: {
            location: "managedWorktree",
            workspaceBinding: { kind: "managed", workspaceId: "mw:s1" },
            managedWorkspace: { availability: "missing-on-device" },
            projectId: "",
            projectRoot: "",
            taskWorkspace: { taskId: "task:s1", workspaceKey: "mw:s1" },
          },
        },
      ]),
      { since: 0 }
    )

    const row = await getDb().sessions.get("s1")
    expect(row?.title).toBe("Remote title")
    expect(row?.executionContext?.projectRoot).toBe("/local/root")
    expect(row?.executionContext?.managedWorkspace).toEqual(
      expect.objectContaining({ availability: "available", localRoot: "/local/root" })
    )
  })
})

it("rejects cancellation after asynchronous merge preparation", async () => {
  const table = getDb().sessions
  let current = true
  const read = jest.spyOn(table, "bulkGet").mockImplementation(() =>
    Dexie.Promise.resolve().then(() => {
      current = false
      return []
    })
  )
  const write = jest.spyOn(table, "bulkPut")
  const assertCurrent = () => {
    if (!current) throw new Error("scope cancelled")
  }
  try {
    expect(
      (await syncSessions(transportFor([{ id: "cancelled" }]), { since: 0, assertCurrent })).ok
    ).toBe(false)
    expect(read).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    write.mockRestore()
  }
})

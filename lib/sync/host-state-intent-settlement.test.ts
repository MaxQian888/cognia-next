/**
 * @jest-environment jsdom
 */
import type { AllowedHostStateIntent, HostStateAction } from "@cognia/agent-config-types/host-state"

const folders = {
  discardLocalFolder: jest.fn(async () => undefined),
  writeFolderCreate: jest.fn(async () => undefined),
  writeFolderRename: jest.fn(async () => true),
  writeFolderReorder: jest.fn(async () => undefined),
  writeFolderDelete: jest.fn(async () => undefined),
}
jest.mock("@/lib/db/session-folders", () => folders)

const sessions = {
  bulkSetSessionsPinned: jest.fn(async () => undefined),
  assignSessionToFolder: jest.fn(async () => undefined),
  setSessionRanks: jest.fn(async () => undefined),
}
jest.mock("@/lib/db/sessions", () => sessions)

const deleteSessionsWithTeardown = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/chat/session-deletion", () => ({
  deleteSessionsWithTeardown: (...args: unknown[]) => deleteSessionsWithTeardown(...args),
}))

const moveSessionWorkspaceLocally = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  status: "moved",
}))
jest.mock("@/lib/chat/session-workspace-move-writes", () => ({
  moveSessionWorkspaceLocally: (...args: unknown[]) => moveSessionWorkspaceLocally(...args),
}))

const folderRows = new Map<string, unknown>()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessionFolders: { get: async (id: string) => folderRows.get(id) } }),
}))

import {
  HOST_STATE_UNSUPPORTED_SUBMIT_CODE,
  settleRejectedHostStateIntent,
} from "./host-state-intent-settlement"

function action(intent: AllowedHostStateIntent, sessionId?: string): HostStateAction {
  return {
    channel: sessionId ? `cognia://target/t/sessions/${sessionId}` : "cognia://target/t/sessions",
    accountId: "a",
    runtimeTargetId: "t",
    hostId: "h",
    hostGeneration: 1,
    ...(sessionId ? { sessionId } : {}),
    clientId: "c",
    clientSeq: 1,
    actionId: "act-1",
    createdAt: 1,
    action: intent,
  }
}

beforeEach(() => {
  for (const mock of [...Object.values(folders), ...Object.values(sessions)]) mock.mockClear()
  deleteSessionsWithTeardown.mockClear()
  moveSessionWorkspaceLocally.mockReset().mockResolvedValue({ status: "moved" })
  folderRows.clear()
})

describe("a Host too old to know the intent", () => {
  it("applies every list intent locally, as the client did before routing", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "folder.rename", folderId: "f1", name: "Home" }),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "folder.reorder", projectId: "p1", orderedIds: ["f2", "f1"] }),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "folder.delete", folderId: "f1" }),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.pin", pinned: true }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.folder", folderId: null }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.order", manualOrder: 3, sectionKey: "pinned" }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.delete" }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )

    expect(folders.writeFolderRename).toHaveBeenCalledWith("f1", "Home", expect.any(Number))
    expect(folders.writeFolderReorder).toHaveBeenCalledWith("p1", ["f2", "f1"], expect.any(Number))
    expect(folders.writeFolderDelete).toHaveBeenCalledWith("f1", expect.any(Number))
    expect(sessions.bulkSetSessionsPinned).toHaveBeenCalledWith(["s1"], true)
    expect(sessions.assignSessionToFolder).toHaveBeenCalledWith("s1", null)
    expect(sessions.setSessionRanks).toHaveBeenCalledWith([{ id: "s1", manualOrder: 3 }], "pinned")
    expect(deleteSessionsWithTeardown).toHaveBeenCalledWith(["s1"])
  })

  it("replays a workspace move locally, re-planned on this device", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "session.workspace", projectId: "p2" }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
    expect(moveSessionWorkspaceLocally).toHaveBeenCalledWith("s1", "p2")
  })

  it("drops a workspace move this device's plan now refuses", async () => {
    moveSessionWorkspaceLocally.mockResolvedValueOnce({
      status: "refused",
      reason: "session-running",
    })
    await expect(
      settleRejectedHostStateIntent(
        action({ kind: "session.workspace", projectId: "p2" }, "s1"),
        HOST_STATE_UNSUPPORTED_SUBMIT_CODE
      )
    ).resolves.toBeUndefined()
    expect(moveSessionWorkspaceLocally).toHaveBeenCalledTimes(1)
  })

  it("keeps an optimistic folder, and restores it only if it went missing", async () => {
    const create = action({ kind: "folder.create", folderId: "f1", projectId: "p1", name: "Work" })
    folderRows.set("f1", { id: "f1" })
    await settleRejectedHostStateIntent(create, HOST_STATE_UNSUPPORTED_SUBMIT_CODE)
    expect(folders.writeFolderCreate).not.toHaveBeenCalled()
    expect(folders.discardLocalFolder).not.toHaveBeenCalled()

    folderRows.clear()
    await settleRejectedHostStateIntent(create, HOST_STATE_UNSUPPORTED_SUBMIT_CODE)
    expect(folders.writeFolderCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "f1", projectId: "p1", name: "Work" })
    )
  })
})

describe("a Host that understood and refused", () => {
  it("discards the optimistic row of a refused folder create", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "folder.create", folderId: "f1", projectId: "p1", name: "Work" }),
      "host_state_forbidden"
    )
    expect(folders.discardLocalFolder).toHaveBeenCalledWith("f1")
  })

  it("writes nothing locally for any other refused intent", async () => {
    await settleRejectedHostStateIntent(
      action({ kind: "folder.delete", folderId: "f1" }),
      "session_handoff_locked"
    )
    await settleRejectedHostStateIntent(
      action({ kind: "session.pin", pinned: true }, "s1"),
      "host_state_forbidden"
    )
    // The Host's refusal of a move (a turn it is running) is the answer.
    await settleRejectedHostStateIntent(
      action({ kind: "session.workspace", projectId: "p2" }, "s1"),
      "host_state_move_session_running"
    )
    for (const mock of [...Object.values(folders), ...Object.values(sessions)]) {
      expect(mock).not.toHaveBeenCalled()
    }
    expect(moveSessionWorkspaceLocally).not.toHaveBeenCalled()
  })
})

it("swallows a failing local fallback so a settled row stays settled", async () => {
  sessions.bulkSetSessionsPinned.mockRejectedValueOnce(new Error("locked"))
  await expect(
    settleRejectedHostStateIntent(
      action({ kind: "session.pin", pinned: false }, "s1"),
      HOST_STATE_UNSUPPORTED_SUBMIT_CODE
    )
  ).resolves.toBeUndefined()
})

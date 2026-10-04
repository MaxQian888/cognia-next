jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: jest.fn(),
  getTaskScheduler: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ listSessions: jest.fn() }))
jest.mock("@/lib/chat/session-archive-writes", () => ({ setSessionsArchived: jest.fn() }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ hostOwnsSessionState: jest.fn(() => false) }))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: {
    getState: jest.fn(() => ({
      activeSessionId: null,
      sessions: {},
      openSessionIds: [],
      paneIdsBySession: {},
      backgroundHolds: {},
      splitSessionId: null,
    })),
  },
}))

import type { ChatSession } from "@cognia/agent-config-types"

import { setSessionsArchived } from "@/lib/chat/session-archive-writes"
import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { listSessions } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { getTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { isMaintenanceTask } from "@/lib/scheduler/maintenance-tasks"
import { useChatStore } from "@/stores/chat/chat-store"

import { AUTO_ARCHIVE_DAY_MS } from "./auto-archive"
import {
  CONVERSATION_AUTO_ARCHIVE_INTERVAL_MS,
  CONVERSATION_AUTO_ARCHIVE_TASK_TAG,
  CONVERSATION_AUTO_ARCHIVE_TASK_TYPE,
  installConversationAutoArchiveSchedule,
  registerConversationAutoArchiveExecutor,
  runConversationAutoArchive,
  type ConversationLiveState,
} from "./auto-archive-schedule"

const NOW = 1_800_000_000_000
const old = NOW - 40 * AUTO_ARCHIVE_DAY_MS
const session = (id: string, patch: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, createdAt: old, updatedAt: old, lastMessageAt: old, ...patch }) as ChatSession

const idle: ConversationLiveState = {
  activeSessionId: null,
  runningIds: new Set(),
  openIds: new Set(),
}

function deps(overrides: Partial<Parameters<typeof runConversationAutoArchive>[0]> = {}) {
  return {
    now: () => NOW,
    getSettings: jest.fn(async () => ({ conversationArchive: { autoArchiveAfterDays: 30 } })),
    hostOwnsSessions: jest.fn(() => false),
    listSessions: jest.fn(async () => [session("a"), session("b", { pinned: true })]),
    liveState: jest.fn(async () => idle),
    archive: jest.fn(async () => undefined),
    ...overrides,
  }
}

describe("runConversationAutoArchive", () => {
  it("does nothing when the policy is off", async () => {
    const d = deps({ getSettings: jest.fn(async () => ({})) })
    await expect(runConversationAutoArchive(d)).resolves.toEqual({
      scanned: 0,
      archived: 0,
      skipped: "off",
    })
    expect(d.listSessions).not.toHaveBeenCalled()
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("treats an out-of-list day count as off", async () => {
    const d = deps({
      getSettings: jest.fn(async () => ({ conversationArchive: { autoArchiveAfterDays: 3 } })),
    })
    await expect(runConversationAutoArchive(d)).resolves.toMatchObject({ skipped: "off" })
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("skips on a paired client whose Host owns the conversations", async () => {
    const d = deps({ hostOwnsSessions: jest.fn(() => true) })
    await expect(runConversationAutoArchive(d)).resolves.toEqual({
      scanned: 0,
      archived: 0,
      skipped: "host-owned",
    })
    expect(d.listSessions).not.toHaveBeenCalled()
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("archives the eligible conversations and reports the counts", async () => {
    const d = deps({
      listSessions: jest.fn(async () => [
        session("old"),
        session("pinned", { pinned: true }),
        session("active"),
        session("running"),
        session("open"),
        session("fresh", { lastMessageAt: NOW - AUTO_ARCHIVE_DAY_MS, updatedAt: NOW }),
      ]),
      liveState: jest.fn(async () => ({
        activeSessionId: "active",
        runningIds: new Set(["running"]),
        openIds: new Set(["open"]),
      })),
    })
    await expect(runConversationAutoArchive(d)).resolves.toEqual({
      scanned: 6,
      archived: 1,
      afterDays: 30,
    })
    expect(d.archive).toHaveBeenCalledWith(["old"])
  })

  it("writes nothing when no conversation qualifies", async () => {
    const d = deps({ listSessions: jest.fn(async () => [session("p", { pinned: true })]) })
    await expect(runConversationAutoArchive(d)).resolves.toEqual({
      scanned: 1,
      archived: 0,
      afterDays: 30,
    })
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("propagates an archive failure", async () => {
    const d = deps({ archive: jest.fn(async () => Promise.reject(new Error("locked"))) })
    await expect(runConversationAutoArchive(d)).rejects.toThrow("locked")
  })

  it("uses the shared settings, routing predicate, chat store and routed archive by default", async () => {
    jest.mocked(getSettings).mockResolvedValue({
      conversationArchive: { autoArchiveAfterDays: 7 },
    } as Awaited<ReturnType<typeof getSettings>>)
    jest
      .mocked(listSessions)
      .mockResolvedValue([
        session("old"),
        session("tab"),
        session("pane"),
        session("held"),
        session("split"),
        session("streaming"),
        session("errored"),
      ])
    jest.mocked(useChatStore.getState).mockReturnValue({
      activeSessionId: null,
      sessions: { streaming: { status: "streaming" }, errored: { status: "error" } },
      openSessionIds: ["tab"],
      paneIdsBySession: { pane: ["p1"], empty: [] },
      backgroundHolds: { held: ["holder"] },
      splitSessionId: "split",
    } as unknown as ReturnType<typeof useChatStore.getState>)
    jest.mocked(hostOwnsSessionState).mockReturnValue(false)

    await expect(runConversationAutoArchive({ now: () => NOW })).resolves.toEqual({
      scanned: 7,
      archived: 2,
      afterDays: 7,
    })
    // An errored turn is not in flight: the conversation is idle.
    expect(setSessionsArchived).toHaveBeenCalledWith(["old", "errored"], true)
  })

  it("asks the shared routing predicate whether the Host owns the rows", async () => {
    jest.mocked(getSettings).mockResolvedValue({
      conversationArchive: { autoArchiveAfterDays: 7 },
    } as Awaited<ReturnType<typeof getSettings>>)
    jest.mocked(hostOwnsSessionState).mockReturnValue(true)
    await expect(runConversationAutoArchive()).resolves.toMatchObject({ skipped: "host-owned" })
  })
})

describe("conversation auto-archive schedule", () => {
  beforeEach(() => {
    jest.mocked(registerTaskExecutor).mockClear()
    jest.mocked(getTaskScheduler).mockReset()
  })

  it("registers the executor without touching the schedule", () => {
    registerConversationAutoArchiveExecutor()
    expect(registerTaskExecutor).toHaveBeenCalledWith(
      CONVERSATION_AUTO_ARCHIVE_TASK_TYPE,
      expect.any(Function)
    )
    expect(getTaskScheduler).not.toHaveBeenCalled()
  })

  it("reports a failed sweep as a failed run", async () => {
    registerConversationAutoArchiveExecutor()
    const executor = jest.mocked(registerTaskExecutor).mock.calls[0]![1]
    jest.mocked(getSettings).mockRejectedValueOnce(new Error("db closed"))
    await expect(executor({} as never, {} as never, new AbortController().signal)).resolves.toEqual(
      { success: false, error: "db closed" }
    )
  })

  it("reports a sweep's counts as the run output", async () => {
    registerConversationAutoArchiveExecutor()
    const executor = jest.mocked(registerTaskExecutor).mock.calls[0]![1]
    jest.mocked(getSettings).mockResolvedValueOnce({} as Awaited<ReturnType<typeof getSettings>>)
    await expect(executor({} as never, {} as never, new AbortController().signal)).resolves.toEqual(
      { success: true, output: { scanned: 0, archived: 0, skipped: "off" } }
    )
  })

  it("creates one silent maintenance task when none exists", async () => {
    const createTask = jest.fn(async () => undefined)
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: jest.fn(async () => [{ type: "provider-diagnostics-refresh" }]),
      createTask,
    } as unknown as ReturnType<typeof getTaskScheduler>)

    await installConversationAutoArchiveSchedule()

    expect(registerTaskExecutor).toHaveBeenCalledTimes(1)
    expect(createTask).toHaveBeenCalledTimes(1)
    const [input] = createTask.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(input).toMatchObject({
      type: CONVERSATION_AUTO_ARCHIVE_TASK_TYPE,
      trigger: { type: "interval", intervalMs: CONVERSATION_AUTO_ARCHIVE_INTERVAL_MS },
      config: { runMissedOnStartup: true, maxMissedRuns: 1 },
      notification: {
        dueReminder: false,
        onStart: false,
        onComplete: false,
        onError: true,
        onProgress: false,
        channels: ["none"],
      },
      createdBy: { kind: "user" },
      tags: [CONVERSATION_AUTO_ARCHIVE_TASK_TAG],
    })
    expect(CONVERSATION_AUTO_ARCHIVE_INTERVAL_MS).toBe(6 * 60 * 60_000)
    expect(isMaintenanceTask(input as never)).toBe(true)
  })

  it("does not create a second task", async () => {
    const createTask = jest.fn()
    jest.mocked(getTaskScheduler).mockReturnValue({
      getAllTasks: jest.fn(async () => [{ type: CONVERSATION_AUTO_ARCHIVE_TASK_TYPE }]),
      createTask,
    } as unknown as ReturnType<typeof getTaskScheduler>)

    await installConversationAutoArchiveSchedule()

    expect(createTask).not.toHaveBeenCalled()
  })
})

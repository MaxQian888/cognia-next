/** @jest-environment jsdom */

const updateSessionMock = jest.fn(async () => undefined)
/**
 * Present by default. `updateSession` reads the row back before it writes,
 * because Dexie resolves an update against a missing key instead of refusing
 * it, so a mock that answered `undefined` would make every write in this file
 * look like a write to a deleted conversation. Tests that care about the row's
 * contents (the freshness block) still queue their own with
 * `mockResolvedValueOnce`, and the one that cares about absence clears it.
 */
const getSessionMock = jest.fn(async (id: string) => ({ id }) as unknown)

jest.mock("@/lib/db/sessions", () => ({
  createSession: jest.fn(async () => ({ id: "created" })),
  deleteSession: jest.fn(async () => undefined),
  getSession: (...args: unknown[]) => getSessionMock(...(args as [string])),
  listSessions: jest.fn(async () => []),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))

/**
 * The chat store is the authoritative active-session pointer; this store only
 * mirrors it. Faked down to the two members the mirror uses so a test can move
 * the pointer the way a new chat does.
 */
let chatState: { activeSessionId: string | null } = { activeSessionId: null }
const chatListeners = new Set<(s: typeof chatState) => void>()
function setActiveChatSession(id: string | null): void {
  chatState = { activeSessionId: id }
  for (const listener of [...chatListeners]) listener(chatState)
}

jest.mock("./chat-store", () => ({
  useChatStore: {
    getState: () => chatState,
    subscribe: (listener: (s: typeof chatState) => void) => {
      chatListeners.add(listener)
      return () => chatListeners.delete(listener)
    },
  },
}))

/**
 * The store installs a Dexie `updating` hook so a write that bypasses it (the
 * host composer's own effort chip goes straight to `lib/db/sessions`) still
 * refreshes the cache. Captured here so a test can fire it.
 */
const sessionHooks: Record<string, (...args: unknown[]) => void> = {}
jest.mock("@/lib/db", () => ({
  db: {
    sessions: {
      hook: (name: string, handler: (...args: unknown[]) => void) => {
        sessionHooks[name] = handler
      },
    },
  },
}))

jest.mock("@/lib/claude/computer-use-active-settings", () => ({
  clearActiveComputerUseSettings: jest.fn(),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: { virtualDisplayRelease: jest.fn(async () => undefined) },
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

/**
 * A workspace move is three writes, so the store reaches the project store, the
 * move planner and the execution broker. Faked down to what the move reads and
 * asserts on, so a suite can prove the roster moved without a Dexie project
 * table behind it.
 */
const projectState: {
  projects: Array<{ id: string; roots: unknown[] }>
  linked: Array<[string, string]>
  unlinked: Array<[string, string]>
  loads: number
} = { projects: [], linked: [], unlinked: [], loads: 0 }

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: projectState.projects,
      // Awaited by the move, because the real store's `persist()` no-ops until
      // it has run and the roster half of the move would silently reach no row.
      load: async () => {
        projectState.loads += 1
      },
      addSessionToProject: (projectId: string, sessionId: string) =>
        projectState.linked.push([projectId, sessionId]),
      removeSessionFromProject: (projectId: string, sessionId: string) =>
        projectState.unlinked.push([projectId, sessionId]),
    }),
  },
}))

let sessionRunning = false
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({ hasActiveSession: () => sessionRunning }),
}))

import { __resetSessionWriteHookForTesting, useSessionStore } from "./session-store"

/**
 * `load()` installs the Dexie write hook behind a dynamic import and does not
 * await it, so a test that fires the hook has to let that settle first.
 */
async function flushWriteHookInstall(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("plugin session store reasoning updates", () => {
  beforeEach(() => {
    updateSessionMock.mockClear()
    getSessionMock.mockClear()
    chatListeners.clear()
    projectState.projects = [{ id: "proj-9", roots: [] }]
    projectState.loads = 0
    projectState.linked = []
    projectState.unlinked = []
    sessionRunning = false
    chatState = { activeSessionId: "session-1" }
    useSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Analysis",
          kind: "direct",
          createdAt: 1,
          updatedAt: 1,
          effort: "medium",
          thinkingLevel: "medium",
        },
      ],
      activeSessionId: "session-1",
      loaded: true,
    })
  })

  it("persists the effort and full thinking-level identity", async () => {
    const write = useSessionStore.getState().updateSession("session-1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })

    // The in-memory half is synchronous, so a subscriber re-renders in this
    // tick. The Dexie half now waits on the existence read that stops this
    // promise resolving for a conversation that is no longer there.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
    await write

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  /**
   * The in-memory row moving is not evidence the tier was saved. A caller that
   * tells the user "set to Assault" needs the Dexie failure, not a promise that
   * resolves regardless, so the write is returned rather than swallowed.
   */
  it("reports a failed persistence instead of resolving anyway", async () => {
    updateSessionMock.mockRejectedValueOnce(new Error("content cipher locked"))

    await expect(
      useSessionStore.getState().updateSession("session-1", { thinkingLevel: "high" })
    ).rejects.toThrow("content cipher locked")
  })

  /**
   * `mode` has no `ChatSession` column, so this resolve is a statement about a
   * write that was never owed, not about one that landed. The gap is in the
   * schema; the docstring on `updateSession` is where it is admitted, because a
   * resolved promise cannot say it.
   */
  it("resolves without a write for the fields that have no column", async () => {
    await expect(
      useSessionStore
        .getState()
        .updateSession("session-1", { mode: "agent", metadata: { pinnedBy: "me" } })
    ).resolves.toBeUndefined()
    expect(updateSessionMock).not.toHaveBeenCalled()
    // Both reach the cached row. "In-memory only" is a statement about
    // persistence, not about whether a `getSession` straight after can see it.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      mode: "agent",
      metadata: { pinnedBy: "me" },
    })
  })

  /**
   * `updatedAt` is the key `listSessions` sorts on. Stamping it for a patch
   * that reaches no column floated the conversation to the top of the list on
   * a recency the database never received, and the order silently changed back
   * on the next reload or re-read.
   */
  it("does not advance the sort key for a patch that persists nothing", async () => {
    await useSessionStore.getState().updateSession("session-1", { mode: "agent" })

    expect(useSessionStore.getState().sessions[0].updatedAt).toBe(1)
  })

  it("does advance it for one that persists something", async () => {
    await useSessionStore.getState().updateSession("session-1", { title: "Renamed" })

    expect(useSessionStore.getState().sessions[0].updatedAt).not.toBe(1)
  })

  /**
   * `projectId` has had its own column since the workspace-isolation bump. It
   * used to be packed into `scratchpad`, which nothing read back (so the link
   * never survived a reload) and which an imported session uses for its notes.
   */
  it("writes projectId to its own column instead of the scratchpad blob", async () => {
    await useSessionStore.getState().updateSession("session-1", { projectId: "proj-9" })

    expect(updateSessionMock.mock.calls[0][1]).toMatchObject({ projectId: "proj-9" })
    expect(updateSessionMock.mock.calls[0][1]).not.toHaveProperty("scratchpad")
  })

  /**
   * The column is only part of the answer. The roster on `Project.sessionIds`
   * and the session's own `executionContext` name the workspace too, so a
   * column-only write left the conversation listed under the workspace it had
   * left and still RUNNING in that workspace's directory.
   */
  it("moves the roster and rebuilds the execution context, not just the column", async () => {
    await useSessionStore.getState().updateSession("session-1", { projectId: "proj-9" })

    expect(updateSessionMock.mock.calls[0][1]).toHaveProperty("executionContext")
    expect(projectState.linked).toEqual([["proj-9", "session-1"]])
  })

  it("unlinks the previous workspace when the conversation moves out of one", async () => {
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], projectId: "proj-1" }],
    })

    await useSessionStore.getState().updateSession("session-1", { projectId: "proj-9" })

    expect(projectState.unlinked).toEqual([["proj-1", "session-1"]])
    expect(projectState.linked).toEqual([["proj-9", "session-1"]])
  })

  /**
   * The turn in flight holds a lease against the old workspace, so re-pointing
   * underneath it would settle its patches into a directory nobody is watching.
   * The in-app move refuses this, and a plugin must not be the shorter way in.
   */
  it("refuses to move a conversation that is running", async () => {
    sessionRunning = true

    await expect(
      useSessionStore.getState().updateSession("session-1", { projectId: "proj-9" })
    ).rejects.toThrow(/session-running/)
    expect(projectState.linked).toEqual([])
  })

  it("refuses a destination workspace that does not exist", async () => {
    await expect(
      useSessionStore.getState().updateSession("session-1", { projectId: "nope" })
    ).rejects.toThrow(/unknown-workspace/)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("can clear the workspace link, not just set it", async () => {
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], projectId: "proj-1" }],
    })

    await useSessionStore.getState().updateSession("session-1", { projectId: undefined })

    // Unlinking has no destination, so there is no context to rebuild against.
    // The old one is cleared rather than left: it names the workspace the
    // conversation just left, and keeping it would run the next turn in that
    // directory under a row that belongs to no workspace at all.
    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      projectId: undefined,
      executionContext: undefined,
    })
    expect(projectState.unlinked).toEqual([["proj-1", "session-1"]])
    expect(useSessionStore.getState().sessions[0].projectId).toBeUndefined()
  })

  /**
   * The refusals belong to the direction of travel, not to having a
   * destination. A turn in flight holds its lease against the old workspace
   * either way, and unlinking underneath it is the same mis-attribution a move
   * is refused for. This branch skipped `planSessionMove` entirely, so it was
   * the shorter way in that the routing exists to close.
   */
  it("refuses to unlink a conversation that is running", async () => {
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], projectId: "proj-1" }],
    })
    sessionRunning = true

    await expect(
      useSessionStore.getState().updateSession("session-1", { projectId: undefined })
    ).rejects.toThrow(/session-running/)
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(projectState.unlinked).toEqual([])
    expect(useSessionStore.getState().sessions[0].projectId).toBe("proj-1")
  })

  /** A handed-off row is read-only by contract (ADR-0103), unlink included. */
  it("refuses to unlink a handed-off conversation", async () => {
    useSessionStore.setState({
      sessions: [
        {
          ...useSessionStore.getState().sessions[0],
          projectId: "proj-1",
          handoffLock: { ticketId: "t-1" },
        } as never,
      ],
    })

    await expect(
      useSessionStore.getState().updateSession("session-1", { projectId: undefined })
    ).rejects.toThrow(/session-locked/)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  /**
   * The roster half of the move persists through the project store's own
   * `persist()`, which is gated on `loaded` and silently writes nothing before
   * the boot initializer has hydrated. Awaiting `load()` is what stops a
   * resolved promise describing a column that moved and two rosters that did
   * not.
   */
  it("hydrates the project store before writing either half of the move", async () => {
    await useSessionStore.getState().updateSession("session-1", { projectId: "proj-9" })

    expect(projectState.loads).toBeGreaterThan(0)
  })

  /**
   * Dexie resolves `Table.update` against a missing key with a modified count
   * of `0`, and the write guard short-circuits on a row it was handed as
   * `undefined`. Nothing below this store notices, so a plugin showed its
   * "saved" toast for a conversation the user had already deleted.
   */
  it("refuses a write to a conversation that is no longer there", async () => {
    getSessionMock.mockResolvedValueOnce(undefined)

    await expect(
      useSessionStore.getState().updateSession("session-1", { thinkingLevel: "high" })
    ).rejects.toThrow(/no longer exists/)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("can explicitly clear native effort for the standby tier", async () => {
    await useSessionStore.getState().updateSession("session-1", {
      effort: undefined,
      thinkingLevel: "off",
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      effort: undefined,
      thinkingLevel: "off",
    })
    // Spelled with `toHaveProperty` as well: `toHaveBeenCalledWith` treats an
    // explicit `undefined` and an absent key as equal, so on its own it would
    // also pass if `effort` were never sent and the tier never cleared.
    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      effort: undefined,
      thinkingLevel: "off",
    })
    expect(updateSessionMock.mock.calls[0][1]).toHaveProperty("effort")
  })

  /**
   * `effort` and `thinkingLevel` are one setting in two halves, and
   * `ChatSession.thinkingLevel` names `thinkingLevelPatch` as its only supported
   * writer. A plugin can only hand over the halves it knows about, so the store
   * completes the pair rather than persisting a row that renders as one tier and
   * sends another.
   */
  it("completes the tier when a plugin writes only the raw effort", async () => {
    await useSessionStore.getState().updateSession("session-1", { effort: "high" })

    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      effort: "high",
      thinkingLevel: "high",
    })
  })

  it("completes the effort when a plugin writes only the tier", async () => {
    await useSessionStore.getState().updateSession("session-1", { thinkingLevel: "ultracode" })

    // Ultracode's extra behaviour is the workflow-tool coupling, not a deeper
    // effort value, so the half it implies is `xhigh` rather than the stale one.
    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      effort: "xhigh",
      thinkingLevel: "ultracode",
    })
  })

  it("clears the effort when a plugin writes only the standby tier", async () => {
    await useSessionStore.getState().updateSession("session-1", { thinkingLevel: "off" })

    expect(updateSessionMock.mock.calls[0][1]).toHaveProperty("effort")
    expect(updateSessionMock).toHaveBeenCalledWith("session-1", {
      effort: undefined,
      thinkingLevel: "off",
    })
  })

  /**
   * `squadId` is on the accepted-input whitelist and has a column. Dropping it
   * resolved the promise on a handover that never happened.
   */
  it("hands the conversation to a Squad instead of resolving on nothing", async () => {
    await useSessionStore.getState().updateSession("session-1", { squadId: "squad-7" })

    expect(updateSessionMock).toHaveBeenCalledWith("session-1", { squadId: "squad-7" })
    expect(useSessionStore.getState().sessions[0].squadId).toBe("squad-7")
  })

  it("can hand the conversation back to the direct path", async () => {
    useSessionStore.setState({
      sessions: [{ ...useSessionStore.getState().sessions[0], squadId: "squad-7" }],
    })

    await useSessionStore.getState().updateSession("session-1", { squadId: undefined })

    expect(updateSessionMock.mock.calls[0][1]).toHaveProperty("squadId")
    expect(useSessionStore.getState().sessions[0].squadId).toBeUndefined()
  })

  /**
   * The in-memory row moves first so subscribers re-render in the same tick.
   * If the write behind it fails, leaving the row moved would have the control
   * showing the new tier while the toast says it failed.
   */
  it("puts the in-memory row back when the write is rejected", async () => {
    updateSessionMock.mockRejectedValueOnce(new Error("content cipher locked"))

    await expect(
      useSessionStore.getState().updateSession("session-1", {
        effort: "xhigh",
        thinkingLevel: "ultracode",
      })
    ).rejects.toThrow("content cipher locked")

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      effort: "medium",
      thinkingLevel: "medium",
    })
  })

  it("does not roll back over an update that landed after the failed one", async () => {
    let rejectFirst: (err: Error) => void = () => undefined
    updateSessionMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)) as Promise<undefined>
    )

    const failing = useSessionStore.getState().updateSession("session-1", { thinkingLevel: "high" })
    await useSessionStore.getState().updateSession("session-1", { thinkingLevel: "low" })

    rejectFirst(new Error("too late"))
    await expect(failing).rejects.toThrow("too late")

    // The second write is the one the row should reflect.
    expect(useSessionStore.getState().sessions[0].thinkingLevel).toBe("low")
  })

  /**
   * The rollback used to restore the whole row by object identity, which a
   * concurrent write to a DIFFERENT key defeats: it replaces the object, the
   * identity check misses, and the failed call's value stays in the cache for
   * good. Both halves are asserted, because a rollback that fixed the title by
   * reverting the row wholesale would undo the tier that did land.
   */
  it("rolls back only the failed field, leaving a concurrent one that landed", async () => {
    let rejectRename: (err: Error) => void = () => undefined
    updateSessionMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRename = reject)) as Promise<undefined>
    )

    const rename = useSessionStore.getState().updateSession("session-1", { title: "Renamed" })
    await useSessionStore.getState().updateSession("session-1", { thinkingLevel: "low" })

    rejectRename(new Error("content cipher locked"))
    await expect(rename).rejects.toThrow("content cipher locked")

    const row = useSessionStore.getState().sessions[0]
    expect(row.title).toBe("Analysis")
    expect(row.thinkingLevel).toBe("low")
  })
})

describe("plugin session store freshness", () => {
  beforeEach(() => {
    getSessionMock.mockClear()
    chatListeners.clear()
    for (const key of Object.keys(sessionHooks)) delete sessionHooks[key]
    __resetSessionWriteHookForTesting()
    chatState = { activeSessionId: null }
    useSessionStore.setState({ sessions: [], activeSessionId: null, loaded: false })
  })

  /**
   * `load()` runs once and every later session is minted outside this store, so
   * without a re-read the cache answers `null` for every chat started after
   * boot and a plugin sees "no active conversation" while one is open.
   */
  it("pulls in a conversation created after the one-shot hydration", async () => {
    await useSessionStore.getState().load()
    expect(useSessionStore.getState().sessions).toHaveLength(0)

    getSessionMock.mockResolvedValueOnce({ id: "fresh", title: "New chat", thinkingLevel: "high" })
    setActiveChatSession("fresh")
    await Promise.resolve()
    await Promise.resolve()

    expect(getSessionMock).toHaveBeenCalledWith("fresh")
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: "fresh",
      thinkingLevel: "high",
    })
  })

  /**
   * The composer's own effort control writes straight to Dexie, around this
   * cache. A cached row must not keep serving the tier it had at boot.
   */
  it("refreshes a cached row rather than serving the tier it had at boot", async () => {
    await useSessionStore.getState().load()
    useSessionStore.setState({
      sessions: [{ id: "s2", title: "Old", thinkingLevel: "off" } as never],
    })

    getSessionMock.mockResolvedValueOnce({ id: "s2", title: "Old", thinkingLevel: "max" })
    setActiveChatSession("s2")
    await Promise.resolve()
    await Promise.resolve()

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].thinkingLevel).toBe("max")
  })

  /**
   * The composer's own effort chip calls `lib/db/sessions.updateSession`
   * directly, and that is a SAME-session write: the active pointer never moves,
   * so the switch subscription never fires. Without the Dexie hook the dial goes
   * on reporting the tier the row had when the cache was filled.
   */
  it("refreshes on a write that never moves the active pointer", async () => {
    chatState = { activeSessionId: "s3" }
    await useSessionStore.getState().load()
    await flushWriteHookInstall()
    useSessionStore.setState({
      sessions: [{ id: "s3", title: "Open", thinkingLevel: "medium" } as never],
      activeSessionId: "s3",
    })

    expect(sessionHooks.updating).toBeDefined()
    getSessionMock.mockResolvedValueOnce({ id: "s3", title: "Open", thinkingLevel: "xhigh" })
    sessionHooks.updating?.({ thinkingLevel: "xhigh" }, "s3", { id: "s3" })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(useSessionStore.getState().sessions[0].thinkingLevel).toBe("xhigh")
  })

  /**
   * A write to some OTHER conversation buys nothing here and is not free. The
   * cache holds every session after `load()`, so a "is it cached" guard was
   * true for all of them and every one of the ~30 session writes in the app, a
   * streaming title included, cost an IndexedDB `get` plus a rebuilt `sessions`
   * array that re-rendered every subscriber. The hook exists for the write that
   * never moves the pointer, which is by definition the active conversation.
   */
  it("refreshes the active conversation only, not every cached row", async () => {
    chatState = { activeSessionId: "s-active" }
    await useSessionStore.getState().load()
    await flushWriteHookInstall()
    getSessionMock.mockClear()
    useSessionStore.setState({
      sessions: [
        { id: "s-active", title: "Open" } as never,
        { id: "s-background", title: "Cached but not open" } as never,
      ],
      activeSessionId: "s-active",
    })

    expect(sessionHooks.updating).toBeDefined()
    sessionHooks.updating?.({}, "s-background", { id: "s-background" })
    sessionHooks.updating?.({}, "never-seen", { id: "never-seen" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getSessionMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(2)
  })

  /**
   * A delete needs the opposite of a re-read. Pointing the `deleting` hook at
   * the refresh made it a no-op by construction, and since the UI's own delete
   * goes through `lib/db/sessions` rather than this store, the row sat in the
   * cache for the life of the process and `getCurrentSession` could hand a
   * plugin a conversation the user had closed.
   */
  it("evicts a conversation deleted around this store", async () => {
    chatState = { activeSessionId: "s-doomed" }
    await useSessionStore.getState().load()
    await flushWriteHookInstall()
    useSessionStore.setState({
      sessions: [{ id: "s-doomed", title: "Closing" } as never],
      activeSessionId: "s-doomed",
    })

    expect(sessionHooks.deleting).toBeDefined()
    // Gone from Dexie by the time the deferred check runs.
    getSessionMock.mockResolvedValueOnce(undefined)
    sessionHooks.deleting?.("s-doomed", { id: "s-doomed" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(useSessionStore.getState().sessions).toHaveLength(0)
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  /**
   * The hook fires DURING the transaction, so a delete that aborts leaves the
   * row exactly where it was. Evicting on the hook alone would drop a live
   * conversation out of the cache.
   */
  it("keeps a row whose delete transaction aborted", async () => {
    chatState = { activeSessionId: "s-kept" }
    await useSessionStore.getState().load()
    await flushWriteHookInstall()
    useSessionStore.setState({
      sessions: [{ id: "s-kept", title: "Still here" } as never],
      activeSessionId: "s-kept",
    })

    getSessionMock.mockResolvedValueOnce({ id: "s-kept", title: "Still here" })
    sessionHooks.deleting?.("s-kept", { id: "s-kept" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().activeSessionId).toBe("s-kept")
  })

  /**
   * `mode` has no column, so the Dexie row cannot carry it. Replacing the cached
   * row wholesale erased it on every round trip through another conversation.
   */
  it("keeps the column-less fields a switch cannot re-read", async () => {
    chatState = { activeSessionId: "s4" }
    await useSessionStore.getState().load()
    useSessionStore.setState({
      sessions: [{ id: "s4", title: "Open", mode: "agent", thinkingLevel: "low" } as never],
      activeSessionId: "s4",
    })

    setActiveChatSession("other")
    getSessionMock.mockResolvedValueOnce({ id: "s4", title: "Open", thinkingLevel: "high" })
    setActiveChatSession("s4")
    await Promise.resolve()
    await Promise.resolve()

    const row = useSessionStore.getState().sessions.find((s) => s.id === "s4")
    expect(row).toMatchObject({ mode: "agent", thinkingLevel: "high" })
  })

  /**
   * `createSessionAPI` calls `load()` once per plugin context and startup
   * activates dozens of built-ins. A guard that only closed after Dexie answered
   * let every one of them register its own permanent chat-store listener.
   */
  it("registers one chat-store listener even when load races itself", async () => {
    await Promise.all([
      useSessionStore.getState().load(),
      useSessionStore.getState().load(),
      useSessionStore.getState().load(),
    ])

    expect(chatListeners.size).toBe(1)
  })

  /**
   * `dbListSessions` orders by `updatedAt` descending and the plugin API hands
   * `store.sessions` back in array order for an unfiltered `listSessions()`.
   * Prepending an adopted row therefore put whatever conversation the user last
   * switched to at the head of "most recent", however old it was.
   */
  it("files an adopted row by recency rather than at the head", async () => {
    chatState = { activeSessionId: "s-new" }
    await useSessionStore.getState().load()
    useSessionStore.setState({
      sessions: [
        { id: "s-recent", title: "Yesterday", updatedAt: 900 } as never,
        { id: "s-older", title: "Last month", updatedAt: 100 } as never,
      ],
      activeSessionId: "s-new",
    })

    getSessionMock.mockResolvedValueOnce({ id: "s-adopted", title: "Ancient", updatedAt: 500 })
    setActiveChatSession("s-adopted")
    await Promise.resolve()
    await Promise.resolve()

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
      "s-recent",
      "s-adopted",
      "s-older",
    ])
  })

  /**
   * The hook behind the refresh fires on every write to the open conversation,
   * and a `set` that changes no value still rebuilds the array, mints a new row
   * object, and wakes every subscriber. `onSessionChange` subscribes with no
   * selector, so it cannot filter that out for itself.
   */
  it("leaves the cache untouched when the re-read says nothing new", async () => {
    chatState = { activeSessionId: "s-quiet" }
    await useSessionStore.getState().load()
    await flushWriteHookInstall()
    const row = { id: "s-quiet", title: "Open", thinkingLevel: "medium" }
    useSessionStore.setState({ sessions: [row as never], activeSessionId: "s-quiet" })
    const before = useSessionStore.getState().sessions

    let woken = 0
    const stop = useSessionStore.subscribe(() => {
      woken += 1
    })
    // A fresh structured clone, the way IndexedDB always answers, carrying
    // exactly what the cache already holds.
    getSessionMock.mockResolvedValueOnce({ ...row })
    sessionHooks.updating?.({ lastMessageAt: 7 }, "s-quiet", { id: "s-quiet" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
    stop()

    expect(woken).toBe(0)
    expect(useSessionStore.getState().sessions).toBe(before)
  })

  /**
   * The boot pointer needs the same re-read as every later one: a chat started
   * at launch is minted while its Dexie write is still in flight, so the listing
   * can miss it entirely.
   */
  it("re-reads the session that was already active at boot", async () => {
    chatState = { activeSessionId: "booted" }
    getSessionMock.mockResolvedValueOnce({ id: "booted", title: "Launched", thinkingLevel: "max" })

    await useSessionStore.getState().load()
    await Promise.resolve()
    await Promise.resolve()

    expect(getSessionMock).toHaveBeenCalledWith("booted")
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ id: "booted" })
  })
})

/** @jest-environment jsdom */
import { act } from "@testing-library/react"

import { useChatStore, type ChatStatus } from "@/stores/chat/chat-store"
import {
  installImNotifyWatcher,
  listNotifyConversations,
  resolveAutoConversation,
  useImNotifyStore,
  type ImNotifyWatcherDeps,
} from "./im-notify-store"

const toArray = jest.fn()
const sessionsGet = jest.fn()

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    connectorConversationStates: { toArray },
    sessions: { get: sessionsGet },
  }),
}))

const listAdapterInstances = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: () => listAdapterInstances(),
}))

const notifyConversationOverIM = jest.fn().mockResolvedValue("n-real")
jest.mock("@/lib/notifications/conversation-notify", () => ({
  notifyConversationOverIM: (input: unknown) => notifyConversationOverIM(input),
}))

const STRINGS = {
  done: (t: string) => `${t} finished`,
  error: (t: string) => `${t} errored`,
  attention: (t: string) => `${t} needs input`,
}

function setSlice(sessionId: string, status: ChatStatus, runId = 0) {
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [sessionId]: {
        ...s.sessions[sessionId],
        status,
        runId,
      } as (typeof s.sessions)[string],
    },
  }))
}

function installDeps(overrides?: Partial<ImNotifyWatcherDeps>) {
  const push = jest.fn().mockResolvedValue("n1")
  const deps: ImNotifyWatcherDeps = {
    push,
    resolveAuto: jest.fn().mockResolvedValue("ck-auto"),
    sessionTitle: jest.fn().mockResolvedValue("My chat"),
    ...overrides,
  }
  return { push, deps }
}

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  useImNotifyStore.setState({
    enabled: false,
    conversationKey: null,
    events: { done: true, error: true, attention: false },
    armed: {},
  })
  useChatStore.setState({ sessions: {}, status: "idle", activeSessionId: null })
})

describe("im notify prefs", () => {
  it("defaults to off with done+error armed", () => {
    const s = useImNotifyStore.getState()
    expect(s.enabled).toBe(false)
    expect(s.conversationKey).toBeNull()
    expect(s.events).toEqual({ done: true, error: true, attention: false })
  })

  it("toggles individual events", () => {
    useImNotifyStore.getState().toggleEvent("attention")
    expect(useImNotifyStore.getState().events.attention).toBe(true)
    useImNotifyStore.getState().toggleEvent("done")
    expect(useImNotifyStore.getState().events.done).toBe(false)
  })
})

describe("armSession", () => {
  it("is a no-op while the master switch is off", () => {
    useImNotifyStore.getState().armSession("s1")
    expect(useImNotifyStore.getState().armed).toEqual({})
  })

  it("snapshots the prefs at arm time — later edits do not rewrite it", () => {
    useImNotifyStore.setState({ enabled: true, conversationKey: "ck-1" })
    useImNotifyStore.getState().armSession("s1")
    useImNotifyStore.setState({ conversationKey: "ck-2" })
    useImNotifyStore.getState().toggleEvent("error")
    const armed = useImNotifyStore.getState().armed.s1
    expect(armed.conversationKey).toBe("ck-1")
    expect(armed.events.error).toBe(true)
  })

  it("disarmSession removes only that entry", () => {
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")
    useImNotifyStore.getState().armSession("s2")
    useImNotifyStore.getState().disarmSession("s1")
    const armed = useImNotifyStore.getState().armed
    expect(armed.s1).toBeUndefined()
    expect(armed.s2).toBeDefined()
    // Disarming a session that was never armed is a no-op.
    useImNotifyStore.getState().disarmSession("s1")
    expect(Object.keys(useImNotifyStore.getState().armed)).toEqual(["s2"])
  })

  it("caps the armed registry, evicting the oldest entries", () => {
    useImNotifyStore.setState({ enabled: true })
    for (let i = 0; i < 205; i++) {
      useImNotifyStore.getState().armSession(`s${i}`)
    }
    const armed = useImNotifyStore.getState().armed
    expect(Object.keys(armed)).toHaveLength(200)
    expect(armed.s0).toBeUndefined()
    expect(armed.s204).toBeDefined()
  })
})

describe("watcher", () => {
  it("pushes done on a streaming → idle edge of an armed session", async () => {
    const { push, deps } = installDeps()
    const un = installImNotifyWatcher(STRINGS, deps)
    useImNotifyStore.setState({ enabled: true, conversationKey: "ck-mine" })
    useImNotifyStore.getState().armSession("s1")

    act(() => setSlice("s1", "streaming", 3))
    act(() => setSlice("s1", "idle", 3))
    await act(async () => {})
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "ck-mine",
        title: "My chat finished",
        level: "success",
        source: "session",
        dedupeKey: "im-notify:s1:done:3",
      })
    )
    un()
  })

  it("pushes error on streaming → error and resolves auto when no channel was picked", async () => {
    const { push, deps } = installDeps()
    const un = installImNotifyWatcher(STRINGS, deps)
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")

    act(() => setSlice("s1", "streaming", 1))
    act(() => setSlice("s1", "error", 1))
    await act(async () => {})
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "ck-auto",
        level: "error",
        title: "My chat errored",
      })
    )
    un()
  })

  it("pushes attention (directed) on streaming → awaiting_approval only when enabled at arm time", async () => {
    const { push, deps } = installDeps()
    const un = installImNotifyWatcher(STRINGS, deps)
    // attention off by default → arm, flip on a DIFFERENT event, still no attention.
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")
    act(() => setSlice("s1", "streaming", 1))
    act(() => setSlice("s1", "awaiting_approval", 1))
    await act(async () => {})
    expect(push).not.toHaveBeenCalled()

    // Arm a second session with attention on.
    useImNotifyStore.getState().toggleEvent("attention")
    useImNotifyStore.getState().armSession("s2")
    act(() => setSlice("s2", "streaming", 2))
    act(() => setSlice("s2", "awaiting_approval", 2))
    await act(async () => {})
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "ck-auto",
        level: "warning",
        directed: true,
        title: "My chat needs input",
        dedupeKey: "im-notify:s2:attention:2",
      })
    )
    un()
  })

  it("ignores unarmed sessions and replayed idle states", async () => {
    const { push, deps } = installDeps()
    const un = installImNotifyWatcher(STRINGS, deps)
    act(() => setSlice("stranger", "streaming", 1))
    act(() => setSlice("stranger", "idle", 1))
    await act(async () => {})
    expect(push).not.toHaveBeenCalled()

    // Armed but lands on idle without ever being busy (hydration replay).
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")
    act(() => setSlice("s1", "idle", 0))
    await act(async () => {})
    expect(push).not.toHaveBeenCalled()
    un()
  })

  it("delivers nothing when no conversation is reachable", async () => {
    const { push, deps } = installDeps({
      resolveAuto: jest.fn().mockResolvedValue(undefined),
    })
    const un = installImNotifyWatcher(STRINGS, deps)
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")
    act(() => setSlice("s1", "streaming", 1))
    act(() => setSlice("s1", "idle", 1))
    await act(async () => {})
    expect(push).not.toHaveBeenCalled()
    un()
  })

  it("reads the active session's top-level status when it has no slice", async () => {
    const { push, deps } = installDeps()
    const un = installImNotifyWatcher(STRINGS, deps)
    useImNotifyStore.setState({ enabled: true, conversationKey: "ck-1" })
    useImNotifyStore.getState().armSession("s-active")

    useChatStore.setState({ activeSessionId: "s-active", status: "streaming" })
    act(() => {
      useChatStore.setState({ status: "idle" })
    })
    await act(async () => {})
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "ck-1", level: "success" })
    )
    un()
  })

  it("uses the real notifyConversationOverIM + session row when deps are not injected", async () => {
    sessionsGet.mockResolvedValue({ title: "DB title" })
    toArray.mockResolvedValue([
      {
        conversationKey: "ck-real",
        adapterId: "a1",
        deliveryTarget: {
          address: {
            conversationKey: "ck-real",
            platform: "lark",
            adapterId: "a1",
            scopeKind: "private",
            containerId: "c",
          },
          conversationRef: {},
          refreshedAt: 0,
        },
      },
    ])
    listAdapterInstances.mockResolvedValue([
      { id: "a1", type: "lark", displayName: "Lark Bot", enabled: true },
    ])
    const un = installImNotifyWatcher(STRINGS)
    useImNotifyStore.setState({ enabled: true })
    useImNotifyStore.getState().armSession("s1")

    act(() => setSlice("s1", "streaming", 5))
    act(() => setSlice("s1", "idle", 5))
    await act(async () => {})
    expect(notifyConversationOverIM).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "ck-real",
        title: "DB title finished",
        source: "session",
        dedupeKey: "im-notify:s1:done:5",
      })
    )
    un()
  })
})

describe("listNotifyConversations", () => {
  const row = (over: Record<string, unknown>) => ({
    conversationKey: "ck",
    adapterId: "a1",
    deliveryReadiness: "all_messages_verified",
    deliveryTarget: {
      address: {
        conversationKey: "ck",
        platform: "lark",
        adapterId: "a1",
        scopeKind: "private",
        containerId: "c",
      },
      conversationRef: {},
      refreshedAt: 0,
    },
    ...over,
  })

  it("lists only rows whose adapter is enabled and unmuted, private first", async () => {
    toArray.mockResolvedValue([
      row({
        conversationKey: "ck-group",
        deliveryTarget: {
          address: {
            platform: "slack",
            adapterId: "a1",
            scopeKind: "group",
            containerId: "c",
            conversationKey: "ck-group",
          },
          conversationRef: {},
          refreshedAt: 0,
        },
      }),
      row({ conversationKey: "ck-private" }),
      row({
        conversationKey: "ck-muted",
        adapterId: "a2",
        deliveryTarget: {
          address: {
            platform: "lark",
            adapterId: "a2",
            scopeKind: "private",
            containerId: "c",
            conversationKey: "ck-muted",
          },
          conversationRef: {},
          refreshedAt: 0,
        },
      }),
      { conversationKey: "ck-no-target", adapterId: "a1", deliveryTarget: null },
    ])
    listAdapterInstances.mockResolvedValue([
      { id: "a1", type: "lark", displayName: "Lark Bot", enabled: true },
      { id: "a2", type: "lark", displayName: "Muted Bot", enabled: true, muted: true },
    ])
    const list = await listNotifyConversations()
    expect(list.map((c) => c.conversationKey)).toEqual(["ck-private", "ck-group"])
    expect(list[0]).toMatchObject({
      adapterName: "Lark Bot",
      platform: "lark",
      scopeKind: "private",
    })
  })

  it("resolveAutoConversation returns the first reachable conversation", async () => {
    toArray.mockResolvedValue([row({})])
    listAdapterInstances.mockResolvedValue([
      { id: "a1", type: "lark", displayName: "Lark Bot", enabled: true },
    ])
    await expect(resolveAutoConversation()).resolves.toBe("ck")
    toArray.mockResolvedValue([])
    await expect(resolveAutoConversation()).resolves.toBeUndefined()
  })
})

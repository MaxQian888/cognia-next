/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
const transportInvoke = jest.fn()
const isRemoteHostActive = jest.fn().mockReturnValue(false)
const tauriHandlers: Record<string, (p: unknown) => void> = {}
const tauriUnsub: jest.Mock[] = []

const onTauriEventMock = jest.fn(async (event: string, fn: (p: unknown) => void) => {
  tauriHandlers[event] = fn
  const u = jest.fn()
  tauriUnsub.push(u)
  return u
})

jest.mock("@/lib/tauri", () => ({
  TAURI_EVENTS: {
    trayNewChat: "tray://new-chat",
    traySettings: "tray://settings",
    trayOpenLogs: "tray://open-logs",
    menuOpenLogs: "menu://open-logs",
    menuPrefix: "menu://",
    cliMatches: "cli://matches",
    cliSecondInstance: "cli://second-instance",
    deepLink: "deep-link://received",
    backgroundJobExited: "jobs://exited",
    backgroundMonitorFired: "jobs://monitor-fired",
  },
  onTauriEvent: (event: string, fn: (p: unknown) => void) => onTauriEventMock(event, fn),
  isTauri: () => isTauriMock(),
  transport: { call: (...args: unknown[]) => transportInvoke(...args) },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => isRemoteHostActive(),
}))

const TAURI_EVENTS = {
  trayNewChat: "tray://new-chat",
  traySettings: "tray://settings",
  trayOpenLogs: "tray://open-logs",
  menuOpenLogs: "menu://open-logs",
  menuPrefix: "menu://",
  cliMatches: "cli://matches",
  cliSecondInstance: "cli://second-instance",
  deepLink: "deep-link://received",
  backgroundJobExited: "jobs://exited",
  backgroundMonitorFired: "jobs://monitor-fired",
}

const emitSchedulerEvent = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...args: unknown[]) => emitSchedulerEvent(...args),
}))

const listenHandlers: Record<string, (e: { payload: unknown }) => void> = {}
const listenUnsub: jest.Mock[] = []
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async (event: string, fn: (e: { payload: unknown }) => void) => {
    listenHandlers[event] = fn
    const u = jest.fn()
    listenUnsub.push(u)
    return u
  }),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}))

const toastSuccess = jest.fn()
const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    message: (...args: unknown[]) => toastMessage(...args),
  },
}))

// The hook resolves tray update toasts via next-intl (reusing settings.about
// keys). Resolve just the keys the tray path touches to their en.json copy.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      "updates.updateAvailableToast": `Update available: ${vars?.version}`,
      "updates.alreadyLatest": "You're on the latest version.",
    }
    return messages[key] ?? key
  },
}))

const setActiveSession = jest.fn()
const clearChatStore = jest.fn()
const startNewSessionMock = jest.fn().mockResolvedValue({ id: "s-new" })
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))
const isMainAppWindowMock = jest.fn(() => true)
jest.mock("@/lib/pet/window-role", () => ({
  isMainAppWindow: () => isMainAppWindowMock(),
}))
const requestOpenSettings = jest.fn()
const setSelectedGuild = jest.fn()
const saveSettings = jest.fn().mockResolvedValue(undefined)

const chatStoreState = {
  setActiveSession: (...a: unknown[]) => setActiveSession(...a),
  clear: () => clearChatStore(),
}
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => chatStoreState },
}))
const uiStoreState = {
  setSelectedGuild: (...a: unknown[]) => setSelectedGuild(...a),
  requestOpenSettings: (...a: unknown[]) => requestOpenSettings(...a),
}
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => uiStoreState },
}))
const findActiveSessionForConversation = jest.fn()
jest.mock("@/lib/connectors/session-bindings", () => ({
  findActiveSessionForConversation: (...args: unknown[]) =>
    findActiveSessionForConversation(...args),
}))
const selectScheduledTask = jest.fn()
jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => ({ selectTask: selectScheduledTask }) },
}))
const settingsStoreState = {
  save: (...a: unknown[]) => saveSettings(...a),
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => settingsStoreState },
}))

const openDialogMock = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialogMock(...a),
}))

const openPathAsWorkspaceMock = jest.fn()
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (...a: unknown[]) => openPathAsWorkspaceMock(...a),
}))

const openExternalMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...a: unknown[]) => openExternalMock(...a),
}))

const dispatchTrayClickMock = jest.fn()
const dispatchShortcutMock = jest.fn()
jest.mock("@/lib/tray/dispatcher", () => ({
  dispatchTrayClick: (...a: unknown[]) => dispatchTrayClickMock(...a),
  dispatchShortcut: (...a: unknown[]) => dispatchShortcutMock(...a),
}))

const checkUpdatesMock = jest.fn()
jest.mock("@/lib/tray/tray-actions", () => ({
  checkUpdates: (...a: unknown[]) => checkUpdatesMock(...a),
  copyDiagnostics: jest.fn().mockResolvedValue(undefined),
  openDataFolder: jest.fn().mockResolvedValue(undefined),
  openDocs: jest.fn().mockResolvedValue(undefined),
  reportIssue: jest.fn().mockResolvedValue(undefined),
  toggleAutostartAction: jest.fn().mockResolvedValue(true),
}))

import { useTauriEvents } from "./use-tauri-events"

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  isMainAppWindowMock.mockClear().mockReturnValue(true)
  startNewSessionMock.mockClear()
  Object.keys(tauriHandlers).forEach((k) => delete tauriHandlers[k])
  Object.keys(listenHandlers).forEach((k) => delete listenHandlers[k])
  tauriUnsub.length = 0
  listenUnsub.length = 0
  onTauriEventMock.mockClear()
  routerPush.mockClear()
  toastSuccess.mockClear()
  toastMessage.mockClear()
  setActiveSession.mockClear()
  clearChatStore.mockClear()
  requestOpenSettings.mockClear()
  setSelectedGuild.mockClear()
  findActiveSessionForConversation.mockReset()
  selectScheduledTask.mockClear()
  saveSettings.mockClear()
  openDialogMock.mockReset()
  openPathAsWorkspaceMock.mockReset()
  openExternalMock.mockClear()
  dispatchTrayClickMock.mockClear()
  dispatchShortcutMock.mockClear()
  checkUpdatesMock.mockReset()
  emitSchedulerEvent.mockClear()
  transportInvoke.mockReset()
  transportInvoke.mockResolvedValue(undefined)
  isRemoteHostActive.mockReturnValue(false)
})

async function flushPromises() {
  // Allow the async subscribe pipeline (await onTauriEvent / listen) to settle.
  await new Promise<void>((r) => setTimeout(r, 0))
}

describe("useTauriEvents", () => {
  it("is a no-op outside Tauri", () => {
    isTauriMock.mockReturnValueOnce(false)
    renderHook(() => useTauriEvents())
    expect(onTauriEventMock).not.toHaveBeenCalled()
  })

  it("subscribes to every tray / menu / cli / deep-link channel", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    expect(onTauriEventMock).toHaveBeenCalledWith(TAURI_EVENTS.trayNewChat, expect.any(Function))
    expect(onTauriEventMock).toHaveBeenCalledWith(TAURI_EVENTS.traySettings, expect.any(Function))
    expect(onTauriEventMock).toHaveBeenCalledWith(TAURI_EVENTS.trayOpenLogs, expect.any(Function))
    expect(onTauriEventMock).toHaveBeenCalledWith(TAURI_EVENTS.cliMatches, expect.any(Function))
    expect(onTauriEventMock).toHaveBeenCalledWith(
      TAURI_EVENTS.cliSecondInstance,
      expect.any(Function)
    )
    expect(onTauriEventMock).toHaveBeenCalledWith(TAURI_EVENTS.deepLink, expect.any(Function))
    expect(listenHandlers[TAURI_EVENTS.menuOpenLogs]).toBeDefined()
    // menu://open-workspace and menu://new-chat are owned by
    // use-menu-event-router, NOT here — a second listener would double-fire
    // (two folder pickers / two sessions) for one menu click.
    expect(listenHandlers["menu://open-workspace"]).toBeUndefined()
    expect(listenHandlers["menu://new-chat"]).toBeUndefined()
    expect(listenHandlers["menu://documentation"]).toBeDefined()
  })

  it("tray New Chat starts a conversation in the DM guild", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.trayNewChat]?.(null)
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    expect(startNewSessionMock).toHaveBeenCalled()
    // The old behavior nuked every open pane and created nothing.
    expect(clearChatStore).not.toHaveBeenCalled()
  })

  // Rust broadcasts tray://* to every window and the pet overlay / popup /
  // island load this same root layout — an unguarded handler would create one
  // conversation per open window.
  it("tray New Chat is a no-op outside the main window", async () => {
    isMainAppWindowMock.mockReturnValue(false)
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.trayNewChat]?.(null)
    expect(startNewSessionMock).not.toHaveBeenCalled()
    expect(setSelectedGuild).not.toHaveBeenCalled()
  })

  it("tray Settings opens the settings dialog without a tab", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.traySettings]?.(null)
    expect(requestOpenSettings).toHaveBeenCalledWith()
  })

  it("tray Check for updates opens Settings → About when an update is available", async () => {
    checkUpdatesMock.mockResolvedValue({ kind: "available", version: "3.1.4" })
    renderHook(() => useTauriEvents())
    await flushPromises()
    listenHandlers["tray://check-updates"]?.({ payload: null })
    await flushPromises()
    expect(toastSuccess).toHaveBeenCalledWith("Update available: 3.1.4")
    expect(requestOpenSettings).toHaveBeenCalledWith("about")
  })

  it("tray Check for updates toasts and stays put when already current", async () => {
    checkUpdatesMock.mockResolvedValue({ kind: "upToDate" })
    renderHook(() => useTauriEvents())
    await flushPromises()
    listenHandlers["tray://check-updates"]?.({ payload: null })
    await flushPromises()
    expect(toastSuccess).toHaveBeenCalledWith("You're on the latest version.")
    expect(requestOpenSettings).not.toHaveBeenCalled()
  })

  it("tray Check for updates swallows an error outcome without navigating", async () => {
    checkUpdatesMock.mockResolvedValue({ kind: "error", message: "offline" })
    renderHook(() => useTauriEvents())
    await flushPromises()
    listenHandlers["tray://check-updates"]?.({ payload: null })
    await flushPromises()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(requestOpenSettings).not.toHaveBeenCalled()
  })

  it("tray Open Logs and menu Open Logs both navigate to /logs", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.trayOpenLogs]?.(null)
    listenHandlers[TAURI_EVENTS.menuOpenLogs]?.({ payload: null })
    expect(routerPush).toHaveBeenNthCalledWith(1, "/logs")
    expect(routerPush).toHaveBeenNthCalledWith(2, "/logs")
  })

  it("does NOT subscribe to menu://new-chat (owned by the menu router)", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    // Subscribing here too would create a second session for one menu click —
    // the listener was removed in favour of use-menu-event-router → newChatAction.
    expect(listenHandlers["menu://new-chat"]).toBeUndefined()
    expect(startNewSessionMock).not.toHaveBeenCalled()
  })

  it("does NOT subscribe to menu://open-workspace (owned by the menu router)", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    // Subscribing here too would fire a second folder picker for one click —
    // the listener was intentionally removed in favour of use-menu-event-router.
    expect(listenHandlers["menu://open-workspace"]).toBeUndefined()
    expect(openDialogMock).not.toHaveBeenCalled()
  })

  it("menu Documentation opens the external Tauri URL", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    await listenHandlers["menu://documentation"]?.({ payload: null })
    await flushPromises()
    expect(openExternalMock).toHaveBeenCalledWith("https://v2.tauri.app")
  })

  it("CLI matches/second-instance fire without throwing", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    expect(() => tauriHandlers[TAURI_EVENTS.cliMatches]?.({ args: [] })).not.toThrow()
    tauriHandlers[TAURI_EVENTS.cliSecondInstance]?.({
      args: ["a", "b"],
      cwd: "/d",
    })
    expect(toastMessage).toHaveBeenCalled()
  })

  describe("deep-link parsing", () => {
    async function fireDeepLinks(urls: string[] | string) {
      renderHook(() => useTauriEvents())
      await flushPromises()
      tauriHandlers[TAURI_EVENTS.deepLink]?.(urls)
    }

    it("chat deep link with id from path activates session", async () => {
      await fireDeepLinks(["cognia://chat/abc"])
      expect(setActiveSession).toHaveBeenCalledWith("abc")
      expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    })

    it("chat deep link with no id is ignored", async () => {
      await fireDeepLinks(["cognia://chat"])
      expect(setActiveSession).not.toHaveBeenCalled()
    })

    it("IM conversation deep link activates its bound session", async () => {
      findActiveSessionForConversation.mockResolvedValue({ id: "session-im" })

      await fireDeepLinks(["cognia://im?conversationKey=discord%3Aa1%3Ac1"])
      await flushPromises()

      expect(findActiveSessionForConversation).toHaveBeenCalledWith("discord:a1:c1")
      expect(setActiveSession).toHaveBeenCalledWith("session-im")
      expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    })

    it("scheduler deep link selects the task and opens the scheduler", async () => {
      await fireDeepLinks(["cognia://scheduler/task/task-42"])
      await flushPromises()

      expect(selectScheduledTask).toHaveBeenCalledWith("task-42")
      expect(routerPush).toHaveBeenCalledWith("/scheduler")
    })

    it("workflow run deep link opens the exact run detail", async () => {
      await fireDeepLinks(["cognia://workflow-run/wf-42/run-9"])

      expect(routerPush).toHaveBeenCalledWith("/workflows/run?id=wf-42&runId=run-9")
      expect(toastMessage).not.toHaveBeenCalled()
    })

    it("settings deep link forwards the tab parameter", async () => {
      await fireDeepLinks(["cognia://settings?tab=advanced"])
      expect(requestOpenSettings).toHaveBeenCalledWith("advanced")
    })

    it("workspace deep link creates/activates a workspace for the path", async () => {
      await fireDeepLinks(["cognia://workspace?path=/work"])
      expect(openPathAsWorkspaceMock).toHaveBeenCalledWith("/work")
    })

    it("unknown deep link surfaces a toast warning", async () => {
      await fireDeepLinks(["cognia://nope"])
      expect(toastMessage).toHaveBeenCalled()
    })

    it("malformed URL falls into the unknown branch", async () => {
      await fireDeepLinks(["::not-a-url::"])
      expect(toastMessage).toHaveBeenCalled()
    })

    it("non-cognia protocol is treated as unknown", async () => {
      await fireDeepLinks(["https://example.com/chat/x"])
      expect(toastMessage).toHaveBeenCalled()
    })

    it("non-array payload still flows through", async () => {
      await fireDeepLinks("cognia://chat/single")
      expect(setActiveSession).toHaveBeenCalledWith("single")
    })
  })

  describe("unified tray / shortcut dispatch", () => {
    it("subscribes to the new unified channels", async () => {
      renderHook(() => useTauriEvents())
      await flushPromises()
      expect(listenHandlers["tray://item-clicked"]).toBeDefined()
      expect(listenHandlers["shortcut://triggered"]).toBeDefined()
    })

    it("tray://item-clicked forwards the payload to dispatchTrayClick", async () => {
      renderHook(() => useTauriEvents())
      await flushPromises()
      const payload = { kind: "slash", command: "goal" }
      listenHandlers["tray://item-clicked"]?.({
        payload: { id: "tray.quick-goal", payload },
      })
      expect(dispatchTrayClickMock).toHaveBeenCalledWith(payload)
    })

    it("tray://item-clicked tolerates a missing payload", async () => {
      renderHook(() => useTauriEvents())
      await flushPromises()
      listenHandlers["tray://item-clicked"]?.({ payload: { id: "x" } })
      expect(dispatchTrayClickMock).toHaveBeenCalledWith(undefined)
    })

    it("shortcut://triggered forwards the id to dispatchShortcut", async () => {
      renderHook(() => useTauriEvents())
      await flushPromises()
      listenHandlers["shortcut://triggered"]?.({ payload: { id: "goal.pause" } })
      expect(dispatchShortcutMock).toHaveBeenCalledWith("goal.pause")
    })

    it("shortcut://triggered ignores empty payloads", async () => {
      renderHook(() => useTauriEvents())
      await flushPromises()
      listenHandlers["shortcut://triggered"]?.({ payload: { id: "" } })
      expect(dispatchShortcutMock).not.toHaveBeenCalled()
    })
  })

  it("unsubscribes every listener on unmount", async () => {
    const { unmount } = renderHook(() => useTauriEvents())
    await flushPromises()
    unmount()
    for (const u of tauriUnsub) {
      expect(u).toHaveBeenCalled()
    }
    for (const u of listenUnsub) {
      expect(u).toHaveBeenCalled()
    }
  })
})

it("forwards native job and monitor terminal events into scheduler event tasks", async () => {
  renderHook(() => useTauriEvents())
  await flushPromises()

  tauriHandlers[TAURI_EVENTS.backgroundJobExited]?.({ jobId: "job-1" })
  tauriHandlers[TAURI_EVENTS.backgroundMonitorFired]?.({ id: "monitor-1" })

  expect(emitSchedulerEvent).toHaveBeenCalledWith("job:exited", { jobId: "job-1" })
  expect(emitSchedulerEvent).toHaveBeenCalledWith("monitor:fired", { id: "monitor-1" })

  isRemoteHostActive.mockReturnValue(true)
  tauriHandlers[TAURI_EVENTS.backgroundJobExited]?.({ jobId: "job-remote" })
  expect(transportInvoke).toHaveBeenCalledWith("scheduled_task_emit_event", {
    eventType: "job:exited",
    data: { jobId: "job-remote" },
  })
})

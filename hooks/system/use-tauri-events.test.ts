/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
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
  },
  onTauriEvent: (event: string, fn: (p: unknown) => void) => onTauriEventMock(event, fn),
  isTauri: () => isTauriMock(),
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
}

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

const setActiveSession = jest.fn()
const clearChatStore = jest.fn()
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

const openExternalMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...a: unknown[]) => openExternalMock(...a),
}))

import { useTauriEvents } from "./use-tauri-events"

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
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
  saveSettings.mockClear()
  openDialogMock.mockReset()
  openExternalMock.mockClear()
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
    expect(listenHandlers["menu://new-chat"]).toBeDefined()
    expect(listenHandlers[TAURI_EVENTS.menuOpenLogs]).toBeDefined()
    expect(listenHandlers["menu://open-workspace"]).toBeDefined()
    expect(listenHandlers["menu://documentation"]).toBeDefined()
  })

  it("tray New Chat clears the active session and reselects DM guild", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.trayNewChat]?.(null)
    expect(clearChatStore).toHaveBeenCalled()
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("tray Settings opens the settings dialog without a tab", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.traySettings]?.(null)
    expect(requestOpenSettings).toHaveBeenCalledWith()
  })

  it("tray Open Logs and menu Open Logs both navigate to /logs", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    tauriHandlers[TAURI_EVENTS.trayOpenLogs]?.(null)
    listenHandlers[TAURI_EVENTS.menuOpenLogs]?.({ payload: null })
    expect(routerPush).toHaveBeenNthCalledWith(1, "/logs")
    expect(routerPush).toHaveBeenNthCalledWith(2, "/logs")
  })

  it("menu New Chat clears chat and selects DM", async () => {
    renderHook(() => useTauriEvents())
    await flushPromises()
    listenHandlers["menu://new-chat"]?.({ payload: null })
    expect(clearChatStore).toHaveBeenCalled()
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  })

  it("menu Open Workspace saves chosen path on success", async () => {
    openDialogMock.mockResolvedValueOnce("/picked")
    renderHook(() => useTauriEvents())
    await flushPromises()
    await listenHandlers["menu://open-workspace"]?.({ payload: null })
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledWith({ defaultWorkingDir: "/picked" })
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("menu Open Workspace ignores cancellation (non-string result)", async () => {
    openDialogMock.mockResolvedValueOnce(null)
    renderHook(() => useTauriEvents())
    await flushPromises()
    await listenHandlers["menu://open-workspace"]?.({ payload: null })
    await flushPromises()
    expect(saveSettings).not.toHaveBeenCalled()
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

    it("settings deep link forwards the tab parameter", async () => {
      await fireDeepLinks(["cognia://settings?tab=advanced"])
      expect(requestOpenSettings).toHaveBeenCalledWith("advanced")
    })

    it("workspace deep link saves the path and toasts", async () => {
      await fireDeepLinks(["cognia://workspace?path=/work"])
      expect(saveSettings).toHaveBeenCalledWith({ defaultWorkingDir: "/work" })
      expect(toastSuccess).toHaveBeenCalled()
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

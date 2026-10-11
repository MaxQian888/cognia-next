import { act, render } from "@testing-library/react"

import type { UseGlanceSourcesResult } from "@/hooks/glance/use-glance-sources"
import type { GlanceRequest } from "@/lib/glance/requests"
import { normalizeGlancePanelSettings } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION } from "@/lib/glance/snapshot"
import type { GlanceSubscription } from "@/lib/tauri/glance"

const routerPush = jest.fn()
jest.mock("next/navigation", () => {
  const router = { push: (path: string) => routerPush(path) }
  return { useRouter: () => router }
})

jest.mock("@/hooks/glance/use-glance-sources", () => {
  const { useSyncExternalStore } = jest.requireActual("react") as typeof import("react")
  const listeners = new Set<() => void>()
  let value: unknown = null
  return {
    useGlanceSources: jest.fn(function useGlanceSources(active: boolean) {
      void active
      return useSyncExternalStore(
        (onChange) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
        () => value
      )
    }),
    __setSources: (next: unknown) => {
      value = next
      listeners.forEach((listener) => listener())
    },
  }
})
jest.mock("@/lib/island/client", () => ({ sendIslandFocusRow: jest.fn() }))
jest.mock("@/lib/island/focus-request", () => ({ requestIslandFocus: jest.fn() }))
jest.mock("@/lib/island/projection-store", () => ({ getIslandProjection: jest.fn() }))
jest.mock("@/lib/notifications/center-request", () => ({ requestNotificationCenter: jest.fn() }))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: jest.fn() }))
jest.mock("@/lib/plugin/commands/registry", () => ({
  executeCommand: jest.fn(),
  getCommand: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/fleet", () => ({
  isIslandWindowOpen: jest.fn(),
  openIslandWindow: jest.fn(),
}))
jest.mock("@/lib/tauri/glance", () => ({
  GLANCE_LEASE_TTL_MS: 60_000,
  onGlanceRequest: jest.fn(),
  onGlanceSubscription: jest.fn(),
  sendGlanceResult: jest.fn(),
  sendGlanceSnapshot: jest.fn(),
}))
jest.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: jest.fn() }))
jest.mock("@/stores/chat", () => {
  const state = { setActiveSession: jest.fn() }
  return { useChatStore: { getState: () => state } }
})
jest.mock("@/stores/settings", () => {
  const state = { settings: {} as Record<string, unknown> | null, save: jest.fn() }
  return { useSettingsStore: { getState: () => state } }
})
jest.mock("@/stores/ui", () => {
  const state = { setSelectedGuild: jest.fn() }
  return { useUIStore: { getState: () => state } }
})

import { getCurrentWindow } from "@tauri-apps/api/window"

import * as sourcesModule from "@/hooks/glance/use-glance-sources"
import { sendIslandFocusRow } from "@/lib/island/client"
import { requestIslandFocus } from "@/lib/island/focus-request"
import { getIslandProjection } from "@/lib/island/projection-store"
import { requestNotificationCenter } from "@/lib/notifications/center-request"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { isTauri } from "@/lib/tauri"
import { isIslandWindowOpen, openIslandWindow } from "@/lib/tauri/fleet"
import {
  onGlanceRequest,
  onGlanceSubscription,
  sendGlanceResult,
  sendGlanceSnapshot,
} from "@/lib/tauri/glance"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"

import GlancePublisherInitializer, {
  executeGlanceRequest,
  GLANCE_PRUNE_INTERVAL_MS,
  GLANCE_PUSH_DEBOUNCE_MS,
  GlancePublisherInitializer as NamedInitializer,
} from "./glance-publisher-initializer"

const useGlanceSourcesMock = sourcesModule.useGlanceSources as unknown as jest.Mock
const setSources = (sourcesModule as unknown as { __setSources: (v: unknown) => void }).__setSources
const sendFocusRowMock = sendIslandFocusRow as jest.Mock
const requestFocusMock = requestIslandFocus as jest.Mock
const projectionMock = getIslandProjection as jest.Mock
const centerMock = requestNotificationCenter as jest.Mock
const mainWindowMock = isMainAppWindow as jest.Mock
const executeCommandMock = executeCommand as jest.Mock
const getCommandMock = getCommand as jest.Mock
const isTauriMock = isTauri as jest.Mock
const islandOpenMock = isIslandWindowOpen as jest.Mock
const openIslandMock = openIslandWindow as jest.Mock
const onRequestMock = onGlanceRequest as jest.Mock
const onSubscriptionMock = onGlanceSubscription as jest.Mock
const sendResultMock = sendGlanceResult as jest.Mock
const sendSnapshotMock = sendGlanceSnapshot as jest.Mock
const getCurrentWindowMock = getCurrentWindow as jest.Mock

const setActiveSession = (
  useChatStore as unknown as { getState: () => { setActiveSession: jest.Mock } }
).getState().setActiveSession
const setSelectedGuild = (
  useUIStore as unknown as { getState: () => { setSelectedGuild: jest.Mock } }
).getState().setSelectedGuild
const settingsState = (
  useSettingsStore as unknown as {
    getState: () => { settings: Record<string, unknown> | null; save: jest.Mock }
  }
).getState()

const NOW = 1_800_000_000_000
const LEASE_TTL = 60_000

function makeSources(overrides: Partial<UseGlanceSourcesResult["quota"]> = {}, marker = "body") {
  const quota = {
    slice: null,
    refreshAll: jest.fn().mockResolvedValue(undefined),
    refreshOne: jest.fn().mockResolvedValue(true),
    enable: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
  return {
    body: { marker, config: normalizeGlancePanelSettings(undefined) },
    quota,
    refreshUsage: jest.fn().mockResolvedValue(undefined),
  } as unknown as UseGlanceSourcesResult
}

function request<T extends Record<string, unknown>>(body: T): GlanceRequest {
  return { requestId: "req-1", consumer: "tray-panel", ...body } as unknown as GlanceRequest
}

describe("executeGlanceRequest", () => {
  let sources: UseGlanceSourcesResult
  let navigate: jest.Mock
  let windowShow: jest.Mock
  let windowFocus: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    sources = makeSources()
    navigate = jest.fn()
    windowShow = jest.fn().mockResolvedValue(undefined)
    windowFocus = jest.fn().mockResolvedValue(undefined)
    getCurrentWindowMock.mockReturnValue({ show: windowShow, setFocus: windowFocus })
    isTauriMock.mockReturnValue(true)
    projectionMock.mockReturnValue(null)
    requestFocusMock.mockResolvedValue(true)
    centerMock.mockReturnValue(true)
    getCommandMock.mockReturnValue({ id: "pet.feed" })
    executeCommandMock.mockResolvedValue(undefined)
    settingsState.settings = {}
    settingsState.save.mockReset()
    settingsState.save.mockResolvedValue(undefined)
  })

  function run(req: GlanceRequest) {
    return executeGlanceRequest(req, { sources, navigate })
  }

  describe("refresh", () => {
    it("refreshes quota only when usage is cognia-scoped", async () => {
      await expect(run(request({ kind: "refresh" }))).resolves.toBeNull()
      expect(sources.quota.refreshAll).toHaveBeenCalledTimes(1)
      expect(sources.refreshUsage).not.toHaveBeenCalled()
    })

    it("also re-reads the external usage index for the all-tools scope", async () => {
      settingsState.settings = {
        trayPanelLayout: {
          version: 1,
          options: { usage: { scope: "all-tools", showSpend: false }, activity: { range: "3m" } },
        },
      }
      await expect(run(request({ kind: "refresh" }))).resolves.toBeNull()
      expect(sources.quota.refreshAll).toHaveBeenCalledTimes(1)
      expect(sources.refreshUsage).toHaveBeenCalledTimes(1)
    })

    it("propagates a failing refresh", async () => {
      ;(sources.quota.refreshAll as jest.Mock).mockRejectedValue(new Error("boom"))
      await expect(run(request({ kind: "refresh" }))).rejects.toThrow("boom")
    })
  })

  describe("open-fleet", () => {
    const rows = [
      { id: "w1", status: "working" },
      { id: "b1", status: "blocked" },
      { id: "f1", status: "failed" },
      { id: "b2", status: "blocked" },
      { id: "w2", status: "working" },
    ]

    it("focuses the named row, ignoring the filter", async () => {
      projectionMock.mockReturnValue({ rows })
      await expect(
        run(request({ kind: "open-fleet", rowId: "explicit", filter: "failed" }))
      ).resolves.toBeNull()
      expect(requestFocusMock).toHaveBeenCalledWith("explicit", expect.any(Object))
    })

    it.each([
      ["awaiting", "b1"],
      ["working", "w1"],
      ["failed", "f1"],
    ] as const)("%s picks the first matching row (%s)", async (filter, expected) => {
      projectionMock.mockReturnValue({ rows })
      await run(request({ kind: "open-fleet", filter }))
      expect(requestFocusMock).toHaveBeenCalledWith(expected, expect.any(Object))
    })

    it("focuses no row when nothing matches the filter", async () => {
      projectionMock.mockReturnValue({ rows: [{ id: "w1", status: "working" }] })
      await run(request({ kind: "open-fleet", filter: "failed" }))
      expect(requestFocusMock).toHaveBeenCalledWith(null, expect.any(Object))
    })

    it("focuses no row when there is no island projection yet", async () => {
      projectionMock.mockReturnValue(null)
      await run(request({ kind: "open-fleet", filter: "awaiting" }))
      expect(requestFocusMock).toHaveBeenCalledWith(null, expect.any(Object))
    })

    it("just opens the island with neither a row nor a filter", async () => {
      projectionMock.mockReturnValue({ rows })
      await run(request({ kind: "open-fleet" }))
      expect(requestFocusMock).toHaveBeenCalledWith(null, expect.any(Object))
    })

    it("wires the island window helpers into the focus request", async () => {
      islandOpenMock.mockResolvedValue(true)
      openIslandMock.mockResolvedValue(true)
      sendFocusRowMock.mockResolvedValue(true)
      await run(request({ kind: "open-fleet" }))
      const deps = requestFocusMock.mock.calls[0][1]
      await deps.isOpen()
      await deps.open()
      await deps.send("row-x")
      expect(islandOpenMock).toHaveBeenCalledTimes(1)
      expect(openIslandMock).toHaveBeenCalledTimes(1)
      expect(sendFocusRowMock).toHaveBeenCalledWith("row-x")
      expect(typeof deps.now()).toBe("number")
    })

    it("does not navigate when the island opened", async () => {
      requestFocusMock.mockResolvedValue(true)
      await expect(run(request({ kind: "open-fleet" }))).resolves.toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      expect(windowShow).not.toHaveBeenCalled()
    })

    it("falls back to the run history and focuses the main window when no island opened", async () => {
      requestFocusMock.mockResolvedValue(false)
      await expect(run(request({ kind: "open-fleet" }))).resolves.toBeNull()
      expect(navigate).toHaveBeenCalledWith("/agent-runs")
      expect(windowShow).toHaveBeenCalledTimes(1)
      expect(windowFocus).toHaveBeenCalledTimes(1)
    })
  })

  describe("open-owner", () => {
    it.each([
      ["usage", undefined, "/settings?section=subscription&subTab=usage"],
      ["subscription", undefined, "/settings?section=subscription"],
      ["scheduler", undefined, "/scheduler"],
      ["scheduler", "app:t 1", "/scheduler?item=app%3At%201"],
      ["connectivity", undefined, "/settings?section=connectivity"],
      ["conversations", undefined, "/conversations"],
      ["pet", undefined, "/pet"],
      ["tray-actions", undefined, "/settings?section=desktop"],
      ["fleet", undefined, "/agent-runs"],
    ] as const)(
      "%s (%s) navigates to %s after focusing the main window",
      async (owner, itemId, href) => {
        await expect(run(request({ kind: "open-owner", owner, itemId }))).resolves.toBeNull()
        expect(navigate).toHaveBeenCalledWith(href)
        expect(windowShow).toHaveBeenCalledTimes(1)
        expect(centerMock).not.toHaveBeenCalled()
      }
    )

    it("opens the notification center when a host is mounted and does not navigate", async () => {
      centerMock.mockReturnValue(true)
      await expect(run(request({ kind: "open-owner", owner: "notifications" }))).resolves.toBeNull()
      expect(centerMock).toHaveBeenCalledTimes(1)
      expect(navigate).not.toHaveBeenCalled()
      expect(windowShow).toHaveBeenCalledTimes(1)
    })

    it("falls back to the notification settings when no center host heard the request", async () => {
      centerMock.mockReturnValue(false)
      await expect(run(request({ kind: "open-owner", owner: "notifications" }))).resolves.toBeNull()
      expect(navigate).toHaveBeenCalledWith("/settings?section=notifications")
    })

    it("still navigates when focusing the window throws", async () => {
      windowShow.mockRejectedValue(new Error("no window"))
      await expect(run(request({ kind: "open-owner", owner: "pet" }))).resolves.toBeNull()
      expect(navigate).toHaveBeenCalledWith("/pet")
    })

    it("does not touch the window outside Tauri", async () => {
      isTauriMock.mockReturnValue(false)
      await run(request({ kind: "open-owner", owner: "pet" }))
      expect(getCurrentWindowMock).not.toHaveBeenCalled()
      expect(navigate).toHaveBeenCalledWith("/pet")
    })
  })

  describe("open-session", () => {
    it("activates the session in the chat view and routes home", async () => {
      await expect(run(request({ kind: "open-session", sessionId: "s-9" }))).resolves.toBeNull()
      expect(setActiveSession).toHaveBeenCalledWith("s-9")
      expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
      expect(navigate).toHaveBeenCalledWith("/")
      expect(windowShow).toHaveBeenCalledTimes(1)
      expect(windowFocus).toHaveBeenCalledTimes(1)
    })
  })

  describe("quota", () => {
    it("quota-refresh resolves null when the source refreshed", async () => {
      await expect(run(request({ kind: "quota-refresh", key: "anthropic:a" }))).resolves.toBeNull()
      expect(sources.quota.refreshOne).toHaveBeenCalledWith("anthropic:a")
    })

    it("quota-refresh resolves errors.quotaRefresh when it did not", async () => {
      ;(sources.quota.refreshOne as jest.Mock).mockResolvedValue(false)
      await expect(run(request({ kind: "quota-refresh", key: "k" }))).resolves.toBe(
        "errors.quotaRefresh"
      )
    })

    it("quota-enable resolves null when the account was enabled", async () => {
      await expect(
        run(request({ kind: "quota-enable", provider: "anthropic", accountId: "a" }))
      ).resolves.toBeNull()
      expect(sources.quota.enable).toHaveBeenCalledWith("anthropic", "a")
    })

    it("quota-enable resolves errors.quotaEnable for an unknown account", async () => {
      ;(sources.quota.enable as jest.Mock).mockResolvedValue(false)
      await expect(
        run(request({ kind: "quota-enable", provider: "anthropic", accountId: "ghost" }))
      ).resolves.toBe("errors.quotaEnable")
    })
  })

  describe("layout settings", () => {
    const base = normalizeGlancePanelSettings(undefined)

    it.each([
      ["set-scope", { scope: "workspace" }, { scope: "workspace" }],
      ["set-max-height", { maxHeight: 500 }, { maxHeight: 500 }],
      ["set-width", { width: "wide" }, { width: "wide" }],
      [
        "set-usage-scope",
        { scope: "all-tools" },
        { options: { ...base.options, usage: { ...base.options.usage, scope: "all-tools" } } },
      ],
      [
        "set-show-spend",
        { showSpend: true },
        { options: { ...base.options, usage: { ...base.options.usage, showSpend: true } } },
      ],
      [
        "set-activity-range",
        { range: "1y" },
        { options: { ...base.options, activity: { range: "1y" } } },
      ],
    ] as const)("%s saves the patched layout and resolves null", async (kind, body, patch) => {
      await expect(run(request({ kind, ...body }))).resolves.toBeNull()
      expect(settingsState.save).toHaveBeenCalledTimes(1)
      expect(settingsState.save).toHaveBeenCalledWith({ trayPanelLayout: { ...base, ...patch } })
    })

    it("patches the stored layout, keeping its other fields", async () => {
      settingsState.settings = {
        trayPanelLayout: {
          version: 1,
          preset: "minimal",
          width: "narrow",
          maxHeight: 300,
          scope: "workspace",
          options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
        },
      }
      await run(request({ kind: "set-show-spend", showSpend: false }))
      const saved = settingsState.save.mock.calls[0][0].trayPanelLayout
      expect(saved).toMatchObject({
        preset: "minimal",
        width: "narrow",
        maxHeight: 300,
        scope: "workspace",
        options: { usage: { scope: "all-tools", showSpend: false }, activity: { range: "1m" } },
      })
    })

    it("keeps showSpend when only the usage scope changes", async () => {
      settingsState.settings = {
        trayPanelLayout: {
          version: 1,
          options: { usage: { scope: "cognia", showSpend: true }, activity: { range: "3m" } },
        },
      }
      await run(request({ kind: "set-usage-scope", scope: "all-tools" }))
      expect(settingsState.save.mock.calls[0][0].trayPanelLayout.options.usage).toEqual({
        scope: "all-tools",
        showSpend: true,
      })
    })

    it("propagates a failed save", async () => {
      settingsState.save.mockRejectedValue(new Error("disk full"))
      await expect(run(request({ kind: "set-width", width: "wide" }))).rejects.toThrow("disk full")
    })
  })

  describe("pet-care", () => {
    it.each(["pet.feed", "pet.play", "pet.pet", "pet.sleep", "pet.clean"] as const)(
      "%s runs the registered command",
      async (command) => {
        await expect(run(request({ kind: "pet-care", command }))).resolves.toBeNull()
        expect(getCommandMock).toHaveBeenCalledWith(command)
        expect(executeCommandMock).toHaveBeenCalledWith(command)
      }
    )

    it("resolves errors.commandUnavailable and runs nothing when the command is unknown", async () => {
      getCommandMock.mockReturnValue(undefined)
      await expect(run(request({ kind: "pet-care", command: "pet.feed" }))).resolves.toBe(
        "errors.commandUnavailable"
      )
      expect(executeCommandMock).not.toHaveBeenCalled()
    })

    it("propagates a failing command", async () => {
      executeCommandMock.mockRejectedValue(new Error("pet asleep"))
      await expect(run(request({ kind: "pet-care", command: "pet.feed" }))).rejects.toThrow(
        "pet asleep"
      )
    })
  })
})

describe("GlancePublisherInitializer", () => {
  let offSubscription: jest.Mock
  let offRequest: jest.Mock
  let subscriptionHandler: (subscription: GlanceSubscription) => void
  let requestHandler: (payload: unknown) => void

  const TRAY: GlanceSubscription = { consumer: "tray-panel", windowLabel: "tray", visible: true }
  const DOCK: GlanceSubscription = { consumer: "usage-dock", windowLabel: "dock", visible: true }

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    jest.clearAllMocks()
    routerPush.mockReset()
    offSubscription = jest.fn()
    offRequest = jest.fn()
    subscriptionHandler = () => {}
    requestHandler = () => {}
    isTauriMock.mockReturnValue(true)
    mainWindowMock.mockReturnValue(true)
    onSubscriptionMock.mockImplementation(async (handler: (s: GlanceSubscription) => void) => {
      subscriptionHandler = handler
      return offSubscription
    })
    onRequestMock.mockImplementation(async (handler: (payload: unknown) => void) => {
      requestHandler = handler
      return offRequest
    })
    sendSnapshotMock.mockResolvedValue(true)
    sendResultMock.mockResolvedValue(true)
    getCurrentWindowMock.mockReturnValue({
      show: jest.fn().mockResolvedValue(undefined),
      setFocus: jest.fn().mockResolvedValue(undefined),
    })
    projectionMock.mockReturnValue(null)
    settingsState.settings = {}
    settingsState.save.mockResolvedValue(undefined)
    act(() => setSources(makeSources()))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }

  async function mount() {
    const view = render(<GlancePublisherInitializer />)
    await flush()
    return view
  }

  function subscribe(subscription: GlanceSubscription) {
    act(() => subscriptionHandler(subscription))
  }

  async function advance(ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(ms)
    })
  }

  function lastActiveFlag(): boolean | undefined {
    return useGlanceSourcesMock.mock.calls.at(-1)?.[0]
  }

  it("exports the same component as default and by name, and renders nothing", async () => {
    expect(NamedInitializer).toBe(GlancePublisherInitializer)
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()
  })

  describe("listeners", () => {
    it("registers subscription and request listeners in the main Tauri window", async () => {
      await mount()
      expect(onSubscriptionMock).toHaveBeenCalledTimes(1)
      expect(onRequestMock).toHaveBeenCalledTimes(1)
    })

    it("registers nothing outside Tauri", async () => {
      isTauriMock.mockReturnValue(false)
      await mount()
      expect(onSubscriptionMock).not.toHaveBeenCalled()
      expect(onRequestMock).not.toHaveBeenCalled()
    })

    it("registers nothing in a secondary window", async () => {
      mainWindowMock.mockReturnValue(false)
      await mount()
      expect(onSubscriptionMock).not.toHaveBeenCalled()
      expect(onRequestMock).not.toHaveBeenCalled()
    })

    it("unlistens on unmount", async () => {
      const { unmount } = await mount()
      unmount()
      expect(offSubscription).toHaveBeenCalledTimes(1)
      expect(offRequest).toHaveBeenCalledTimes(1)
    })

    it("unlistens a listener that finishes registering after unmount", async () => {
      let resolveSubscription!: (off: () => void) => void
      onSubscriptionMock.mockImplementationOnce(
        () =>
          new Promise<() => void>((resolve) => {
            resolveSubscription = resolve
          })
      )
      const { unmount } = render(<GlancePublisherInitializer />)
      unmount()
      expect(offSubscription).not.toHaveBeenCalled()
      await act(async () => {
        resolveSubscription(offSubscription)
        await Promise.resolve()
      })
      expect(offSubscription).toHaveBeenCalledTimes(1)
    })

    it("ignores subscriptions and requests after unmount", async () => {
      const { unmount } = await mount()
      unmount()
      expect(() => subscriptionHandler(TRAY)).not.toThrow()
      expect(() =>
        requestHandler({ kind: "refresh", requestId: "r", consumer: "tray-panel" })
      ).not.toThrow()
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      expect(sendResultMock).not.toHaveBeenCalled()
    })
  })

  describe("publishing snapshots", () => {
    it("computes nothing while no consumer is subscribed", async () => {
      await mount()
      expect(lastActiveFlag()).toBe(false)
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 5)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })

    it("activates the sources when a consumer becomes visible", async () => {
      await mount()
      subscribe(TRAY)
      expect(lastActiveFlag()).toBe(true)
    })

    it("pushes a versioned snapshot to the subscribed window after the debounce", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS - 1)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      await advance(1)
      expect(sendSnapshotMock).toHaveBeenCalledTimes(1)
      const [label, snapshot] = sendSnapshotMock.mock.calls[0]
      expect(label).toBe("tray")
      expect(snapshot).toMatchObject({
        version: GLANCE_SNAPSHOT_VERSION,
        epoch: NOW,
        revision: 1,
        marker: "body",
      })
    })

    it("coalesces a burst of source changes into one push of the newest body", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      sendSnapshotMock.mockClear()

      act(() => setSources(makeSources({}, "one")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      act(() => setSources(makeSources({}, "two")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      expect(sendSnapshotMock).toHaveBeenCalledTimes(1)
      expect(sendSnapshotMock.mock.calls[0][1]).toMatchObject({ marker: "two" })
    })

    it("keeps the epoch and increases the revision on every rebuild", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const first = sendSnapshotMock.mock.calls[0][1]
      act(() => setSources(makeSources({}, "next")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const second = sendSnapshotMock.mock.calls[1][1]
      expect(second.epoch).toBe(first.epoch)
      expect(second.revision).toBeGreaterThan(first.revision)
    })

    it("pushes to every live consumer window", async () => {
      await mount()
      subscribe(TRAY)
      subscribe(DOCK)
      sendSnapshotMock.mockClear()
      act(() => setSources(makeSources({}, "fresh")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const labels = sendSnapshotMock.mock.calls.map((c) => c[0]).sort()
      expect(labels).toEqual(["dock", "tray"])
    })

    it("hands a newly appearing consumer the newest snapshot at once", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      sendSnapshotMock.mockClear()

      subscribe(DOCK)
      expect(sendSnapshotMock).toHaveBeenCalledTimes(1)
      expect(sendSnapshotMock.mock.calls[0][0]).toBe("dock")
      expect(sendSnapshotMock.mock.calls[0][1]).toMatchObject({ marker: "body" })
    })

    it("does not re-send on a lease renewal", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      sendSnapshotMock.mockClear()
      subscribe(TRAY)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })

    it("does not send the previous snapshot to a first consumer before anything was built", async () => {
      await mount()
      subscribe(TRAY)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })
  })

  describe("lease end", () => {
    it("stops pushing after the consumer says it is hidden", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      sendSnapshotMock.mockClear()

      subscribe({ ...TRAY, visible: false })
      expect(lastActiveFlag()).toBe(false)
      act(() => setSources(makeSources({}, "after-hide")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })

    it("cancels a push that was still waiting when the consumer hid", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      subscribe({ ...TRAY, visible: false })
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })

    it("keeps pushing to the remaining consumer when another one hides", async () => {
      await mount()
      subscribe(TRAY)
      subscribe(DOCK)
      subscribe({ ...TRAY, visible: false })
      expect(lastActiveFlag()).toBe(true)
      sendSnapshotMock.mockClear()
      act(() => setSources(makeSources({}, "still-one")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      expect(sendSnapshotMock.mock.calls.map((c) => c[0])).toEqual(["dock"])
    })

    it("drops a lease that is not renewed within the TTL", async () => {
      await mount()
      subscribe(TRAY)
      await advance(LEASE_TTL - GLANCE_PRUNE_INTERVAL_MS)
      expect(lastActiveFlag()).toBe(true)

      await advance(GLANCE_PRUNE_INTERVAL_MS)
      expect(lastActiveFlag()).toBe(false)

      sendSnapshotMock.mockClear()
      act(() => setSources(makeSources({}, "after-expiry")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
    })

    it("keeps a renewed lease alive past the original TTL", async () => {
      await mount()
      subscribe(TRAY)
      await advance(30_000)
      subscribe(TRAY)
      await advance(40_000)
      expect(lastActiveFlag()).toBe(true)
      await advance(30_000)
      expect(lastActiveFlag()).toBe(false)
    })

    it("keeps the epoch when a consumer returns after its lease ended", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const first = sendSnapshotMock.mock.calls[0][1]
      subscribe({ ...TRAY, visible: false })
      sendSnapshotMock.mockClear()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const again = sendSnapshotMock.mock.calls.at(-1)![1]
      expect(again.epoch).toBe(first.epoch)
      expect(again.revision).toBeGreaterThan(first.revision)
    })

    it("stops the prune sweep on unmount", async () => {
      const { unmount } = await mount()
      subscribe(TRAY)
      unmount()
      expect(() => jest.advanceTimersByTime(LEASE_TTL * 2)).not.toThrow()
    })
  })

  describe("requests", () => {
    const REFRESH = { kind: "refresh", requestId: "req-1", consumer: "tray-panel" }

    it("answers a valid request to the requesting window with ok", async () => {
      const sources = makeSources()
      act(() => setSources(sources))
      await mount()
      subscribe(TRAY)
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(sources.quota.refreshAll).toHaveBeenCalledTimes(1)
      expect(sendResultMock).toHaveBeenCalledTimes(1)
      expect(sendResultMock).toHaveBeenCalledWith("tray", { requestId: "req-1", ok: true })
    })

    it("answers each consumer in its own window", async () => {
      await mount()
      subscribe(TRAY)
      subscribe(DOCK)
      await act(async () => requestHandler({ ...REFRESH, requestId: "a", consumer: "usage-dock" }))
      await flush()
      expect(sendResultMock).toHaveBeenCalledWith("dock", { requestId: "a", ok: true })
      expect(sendResultMock).not.toHaveBeenCalledWith("tray", expect.anything())
    })

    it("reports the error key of a request that did not succeed", async () => {
      act(() => setSources(makeSources({ refreshOne: jest.fn().mockResolvedValue(false) })))
      await mount()
      subscribe(TRAY)
      await act(async () =>
        requestHandler({
          kind: "quota-refresh",
          key: "anthropic:a",
          requestId: "q",
          consumer: "tray-panel",
        })
      )
      await flush()
      expect(sendResultMock).toHaveBeenCalledWith("tray", {
        requestId: "q",
        ok: false,
        errorKey: "errors.quotaRefresh",
      })
    })

    it("reports errors.requestFailed when execution throws", async () => {
      act(() =>
        setSources(makeSources({ refreshAll: jest.fn().mockRejectedValue(new Error("boom")) }))
      )
      await mount()
      subscribe(TRAY)
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(sendResultMock).toHaveBeenCalledWith("tray", {
        requestId: "req-1",
        ok: false,
        errorKey: "errors.requestFailed",
      })
    })

    it("runs a request against the newest sources", async () => {
      const stale = makeSources()
      act(() => setSources(stale))
      await mount()
      subscribe(TRAY)
      const fresh = makeSources()
      act(() => setSources(fresh))
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(fresh.quota.refreshAll).toHaveBeenCalledTimes(1)
      expect(stale.quota.refreshAll).not.toHaveBeenCalled()
    })

    it("navigates through the router", async () => {
      await mount()
      subscribe(TRAY)
      await act(async () =>
        requestHandler({
          kind: "open-session",
          sessionId: "s1",
          requestId: "o",
          consumer: "tray-panel",
        })
      )
      await flush()
      expect(routerPush).toHaveBeenCalledWith("/")
    })

    it.each([
      ["null", null],
      ["a string", "refresh"],
      ["an unknown kind", { kind: "delete-everything", requestId: "r", consumer: "tray-panel" }],
      ["a missing requestId", { kind: "refresh", consumer: "tray-panel" }],
      ["a missing consumer", { kind: "refresh", requestId: "r" }],
      [
        "an out-of-range max height",
        { kind: "set-max-height", maxHeight: 99999, requestId: "r", consumer: "tray-panel" },
      ],
      [
        "an unknown pet command",
        { kind: "pet-care", command: "pet.explode", requestId: "r", consumer: "tray-panel" },
      ],
      [
        "a bad owner",
        { kind: "open-owner", owner: "elsewhere", requestId: "r", consumer: "tray-panel" },
      ],
    ])("ignores %s without executing or answering", async (_name, payload) => {
      const sources = makeSources()
      act(() => setSources(sources))
      await mount()
      subscribe(TRAY)
      await act(async () => requestHandler(payload))
      await flush()
      expect(sources.quota.refreshAll).not.toHaveBeenCalled()
      expect(settingsState.save).not.toHaveBeenCalled()
      expect(executeCommandMock).not.toHaveBeenCalled()
      expect(sendResultMock).not.toHaveBeenCalled()
    })

    it("executes but does not answer a consumer with no live lease", async () => {
      const sources = makeSources()
      act(() => setSources(sources))
      await mount()
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(sources.quota.refreshAll).toHaveBeenCalledTimes(1)
      expect(sendResultMock).not.toHaveBeenCalled()
    })

    it("does not answer once the consumer's lease has lapsed", async () => {
      await mount()
      subscribe(TRAY)
      await advance(LEASE_TTL)
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(sendResultMock).not.toHaveBeenCalled()
    })

    it("does not answer when the consumer hid before the request arrived", async () => {
      await mount()
      subscribe(TRAY)
      subscribe({ ...TRAY, visible: false })
      await act(async () => requestHandler(REFRESH))
      await flush()
      expect(sendResultMock).not.toHaveBeenCalled()
    })
  })
})

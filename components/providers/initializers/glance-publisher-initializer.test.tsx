import { act, render } from "@testing-library/react"

import type { UseGlanceSourcesResult } from "@/hooks/glance/use-glance-sources"
import type { GlanceRequest } from "@/lib/glance/requests"
import { layoutFromPreset, normalizeGlancePanelSettings } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION } from "@/lib/glance/snapshot"
import type { GlanceSubscription } from "@/lib/tauri/glance"

const routerPush = jest.fn()
jest.mock("next/navigation", () => {
  const router = { push: (path: string) => routerPush(path) }
  return { useRouter: () => router }
})

// Two builds: the tray's (called with `active` only) and the phones' (called
// with options). Each reads its own fake store, so a test can change one
// without touching the other.
jest.mock("@/hooks/glance/use-glance-sources", () => {
  const { useSyncExternalStore } = jest.requireActual("react") as typeof import("react")
  const makeStore = () => ({ value: null as unknown, listeners: new Set<() => void>() })
  const stores = { local: makeStore(), remote: makeStore() }
  const set = (store: ReturnType<typeof makeStore>, next: unknown) => {
    store.value = next
    store.listeners.forEach((listener) => listener())
  }
  return {
    useGlanceSources: jest.fn(function useGlanceSources(active: boolean, options?: unknown) {
      void active
      const store = options === undefined ? stores.local : stores.remote
      return useSyncExternalStore(
        (onChange) => {
          store.listeners.add(onChange)
          return () => store.listeners.delete(onChange)
        },
        () => store.value
      )
    }),
    __setSources: (next: unknown) => set(stores.local, next),
    __setRemoteSources: (next: unknown) => set(stores.remote, next),
  }
})
jest.mock("@/lib/companion/host-event-publisher", () => ({ publishHostEvent: jest.fn() }))
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
  return {
    useSettingsStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("@/stores/ui", () => {
  const state = { setSelectedGuild: jest.fn() }
  return { useUIStore: { getState: () => state } }
})

import { getCurrentWindow } from "@tauri-apps/api/window"

import * as sourcesModule from "@/hooks/glance/use-glance-sources"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { glanceConfigForDemand } from "@/lib/glance/remote/demand"
import { glanceRemoteHub } from "@/lib/glance/remote/host-hub"
import type { GlanceRemoteDemand } from "@/lib/glance/remote/types"
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
  remoteGlanceSnapshot,
} from "./glance-publisher-initializer"

const useGlanceSourcesMock = sourcesModule.useGlanceSources as unknown as jest.Mock
const setSources = (sourcesModule as unknown as { __setSources: (v: unknown) => void }).__setSources
const setRemoteSources = (sourcesModule as unknown as { __setRemoteSources: (v: unknown) => void })
  .__setRemoteSources
const publishMock = publishHostEvent as jest.Mock
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

/** The phones' build: its body carries the `when` the remote snapshot reads. */
function makeRemoteSources(
  overrides: Partial<UseGlanceSourcesResult["quota"]> = {},
  marker = "remote-body",
  usageScope: "cognia" | "all-tools" = "cognia"
) {
  const sources = makeSources(overrides, marker)
  const config = normalizeGlancePanelSettings({
    options: { usage: { scope: usageScope, showSpend: false }, activity: { range: "3m" } },
  })
  return {
    ...sources,
    body: {
      marker,
      config,
      when: {
        goal: { active: true, paused: false, title: "Ship the secret project" },
        automation: { running: false, armed: false },
      },
      actions: [{ id: "trayPanel.delegate" }],
      fleet: { marker: `${marker}-fleet` },
    },
  } as unknown as UseGlanceSourcesResult
}

const PHONE = "dev-A:phone-1"

const PHONE_DEMAND: GlanceRemoteDemand = {
  modules: ["fleet", "usage"],
  scope: "workspace",
  workspaceId: "p1",
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "1y" },
}

/** End every lease a test may have opened and drop the stored build. */
function resetHub() {
  for (const consumer of [PHONE, "dev-B:phone-2"]) {
    glanceRemoteHub.announce({ consumer, visible: false, demand: PHONE_DEMAND }, Date.now())
  }
  glanceRemoteHub.prune(Number.MAX_SAFE_INTEGER)
  glanceRemoteHub.setLatest(null)
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

    describe("set-layout", () => {
      const stored = {
        version: 1,
        preset: "minimal",
        width: "wide",
        maxHeight: 420,
        scope: "workspace",
        showDelegate: false,
        autofocusDelegate: true,
        options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
      }

      it("saves the edited entries as a custom layout and resolves null", async () => {
        settingsState.settings = { trayPanelLayout: stored }
        const entries = [
          { id: "usage", size: "expanded", hidden: false },
          { id: "fleet", size: "compact", hidden: false },
          { id: "pet", size: "standard", hidden: true },
        ]
        await expect(run(request({ kind: "set-layout", entries }))).resolves.toBeNull()
        expect(settingsState.save).toHaveBeenCalledTimes(1)
        const saved = settingsState.save.mock.calls[0][0].trayPanelLayout
        expect(saved.preset).toBe("custom")
        expect(saved.entries.slice(0, 3)).toEqual(entries)
        // Modules the editor did not name are repaired in, hidden.
        expect(saved.entries.map((e: { id: string }) => e.id).sort()).toEqual(
          layoutFromPreset("balanced")
            .map((e) => e.id)
            .sort()
        )
        expect(saved.entries.slice(3).every((e: { hidden: boolean }) => e.hidden)).toBe(true)
      })

      it("keeps width, height, scope, delegate switches and options", async () => {
        settingsState.settings = { trayPanelLayout: stored }
        await run(
          request({
            kind: "set-layout",
            entries: [{ id: "fleet", size: "standard", hidden: false }],
          })
        )
        expect(settingsState.save.mock.calls[0][0].trayPanelLayout).toMatchObject({
          width: "wide",
          maxHeight: 420,
          scope: "workspace",
          showDelegate: false,
          autofocusDelegate: true,
          options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
        })
      })

      it("degrades a size the module does not support", async () => {
        await run(
          request({
            kind: "set-layout",
            entries: [{ id: "agenda", size: "expanded", hidden: false }],
          })
        )
        const saved = settingsState.save.mock.calls[0][0].trayPanelLayout
        expect(saved.entries[0]).toEqual({ id: "agenda", size: "standard", hidden: false })
      })
    })

    describe("apply-preset", () => {
      it("saves the preset's id and entries, keeping width, height and options", async () => {
        settingsState.settings = {
          trayPanelLayout: {
            version: 1,
            preset: "custom",
            width: "narrow",
            maxHeight: 300,
            showDelegate: false,
            options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
          },
        }
        await expect(
          run(request({ kind: "apply-preset", preset: "usage-first" }))
        ).resolves.toBeNull()
        expect(settingsState.save).toHaveBeenCalledTimes(1)
        const saved = settingsState.save.mock.calls[0][0].trayPanelLayout
        expect(saved.preset).toBe("usage-first")
        expect(saved.entries).toEqual(layoutFromPreset("usage-first"))
        expect(saved).toMatchObject({
          width: "narrow",
          maxHeight: 300,
          showDelegate: false,
          options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
        })
      })

      it("returns a custom layout to a preset when settings hold nothing yet", async () => {
        await run(request({ kind: "apply-preset", preset: "minimal" }))
        expect(settingsState.save).toHaveBeenCalledWith({
          trayPanelLayout: {
            ...normalizeGlancePanelSettings(undefined),
            preset: "minimal",
            entries: layoutFromPreset("minimal"),
          },
        })
      })
    })

    describe("set-delegate-visible", () => {
      it.each([true, false])("saves showDelegate %s and keeps the rest", async (visible) => {
        settingsState.settings = {
          trayPanelLayout: {
            version: 1,
            preset: "agent-ops",
            width: "wide",
            showDelegate: !visible,
          },
        }
        await expect(run(request({ kind: "set-delegate-visible", visible }))).resolves.toBeNull()
        const saved = settingsState.save.mock.calls[0][0].trayPanelLayout
        expect(saved).toMatchObject({ showDelegate: visible, preset: "agent-ops", width: "wide" })
        expect(saved.entries).toEqual(normalizeGlancePanelSettings({ preset: "agent-ops" }).entries)
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

describe("remoteGlanceSnapshot", () => {
  const local = {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 7,
    revision: 3,
    generatedAt: 99,
    config: normalizeGlancePanelSettings({ preset: "agent-ops" }),
    workspace: { id: "p1", name: "One" },
    when: {
      goal: { active: true, paused: true, title: "Private objective" },
      automation: { running: true, armed: false },
    },
    actions: [{ id: "trayPanel.delegate" }],
    fleet: { marker: "fleet" },
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  } as unknown as Parameters<typeof remoteGlanceSnapshot>[0]
  const tray = normalizeGlancePanelSettings({ preset: "minimal", width: "wide" })

  it("strips the action catalogue and the goal title", () => {
    const out = remoteGlanceSnapshot(local, tray)
    expect(out.actions).toEqual([])
    expect(out.when.goal).toEqual({ active: true, paused: true })
    expect(out.when.goal).not.toHaveProperty("title")
    expect(out.when).toMatchObject({ automation: { running: true, armed: false } })
  })

  it("attaches the tray layout's preset and entries only", () => {
    const out = remoteGlanceSnapshot(local, tray)
    expect(out.hostLayout).toEqual({ preset: "minimal", entries: tray.entries })
    expect(out.hostLayout).not.toHaveProperty("width")
  })

  it("keeps every other field, the phone's config included", () => {
    const out = remoteGlanceSnapshot(local, tray)
    expect(out).toMatchObject({
      version: GLANCE_SNAPSHOT_VERSION,
      epoch: 7,
      revision: 3,
      generatedAt: 99,
      workspace: { id: "p1", name: "One" },
      fleet: { marker: "fleet" },
    })
    expect(out.config).toBe(local.config)
  })

  it("does not mutate its input", () => {
    const before = JSON.parse(JSON.stringify(local))
    remoteGlanceSnapshot(local, tray)
    expect(JSON.parse(JSON.stringify(local))).toEqual(before)
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
    publishMock.mockResolvedValue(undefined)
    resetHub()
    act(() => setSources(makeSources()))
    act(() => setRemoteSources(makeRemoteSources()))
  })

  afterEach(() => {
    resetHub()
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

  /** The tray build's `active` flag: the call made without options. */
  function lastActiveFlag(): boolean | undefined {
    return useGlanceSourcesMock.mock.calls.filter((call) => call.length < 2).at(-1)?.[0]
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

    it("does not replay the old snapshot to a consumer that appears after the lease ended", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const old = sendSnapshotMock.mock.calls[0][1]

      // The last consumer hides: the snapshot built for it is now stale.
      subscribe({ ...TRAY, visible: false })
      expect(lastActiveFlag()).toBe(false)
      sendSnapshotMock.mockClear()

      // A new consumer announces: it must not be answered with what predates
      // whatever changed while nobody was looking.
      subscribe(DOCK)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      expect(lastActiveFlag()).toBe(true)

      await advance(GLANCE_PUSH_DEBOUNCE_MS - 1)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      await advance(1)
      expect(sendSnapshotMock).toHaveBeenCalledTimes(1)
      const [label, fresh] = sendSnapshotMock.mock.calls[0]
      expect(label).toBe("dock")
      expect(fresh.epoch).toBe(old.epoch)
      expect(fresh.revision).toBeGreaterThan(old.revision)
    })

    it("pushes a freshly built body, not the one from before the lease ended", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      subscribe({ ...TRAY, visible: false })
      // Settings change while nobody is looking.
      act(() => setSources(makeSources({}, "changed-while-hidden")))
      sendSnapshotMock.mockClear()
      subscribe(TRAY)
      expect(sendSnapshotMock).not.toHaveBeenCalled()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      expect(sendSnapshotMock).toHaveBeenCalledTimes(1)
      expect(sendSnapshotMock.mock.calls[0][1]).toMatchObject({ marker: "changed-while-hidden" })
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
  describe("paired phones", () => {
    function announce(demand: GlanceRemoteDemand = PHONE_DEMAND, consumer = PHONE) {
      act(() => {
        glanceRemoteHub.announce({ consumer, visible: true, demand }, Date.now())
      })
    }

    function endLease(consumer = PHONE) {
      act(() => {
        glanceRemoteHub.announce({ consumer, visible: false, demand: PHONE_DEMAND }, Date.now())
      })
    }

    /** The phones' build call: the one made with options. */
    function lastRemoteCall(): [boolean, { config: unknown; workspaceId: unknown }] | undefined {
      return useGlanceSourcesMock.mock.calls.filter((call) => call.length === 2).at(-1) as never
    }

    it("builds nothing for phones while no lease is live", async () => {
      await mount()
      expect(lastRemoteCall()).toEqual([false, { config: null, workspaceId: null }])
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(publishMock).not.toHaveBeenCalled()
      expect(glanceRemoteHub.getLatest(Date.now())).toBeNull()
    })

    it("activates a second build for the announced demand and its workspace", async () => {
      await mount()
      announce()
      expect(lastRemoteCall()).toEqual([
        true,
        { config: glanceConfigForDemand(PHONE_DEMAND), workspaceId: "p1" },
      ])
      // The tray's build stays off: no tray consumer is subscribed.
      expect(lastActiveFlag()).toBe(false)
    })

    it("passes a null workspace for an unscoped demand", async () => {
      await mount()
      announce({ ...PHONE_DEMAND, scope: "all", workspaceId: null })
      expect(lastRemoteCall()?.[1].workspaceId).toBeNull()
    })

    it("keeps the build off for a demand with no modules", async () => {
      await mount()
      const empty = { ...PHONE_DEMAND, modules: [] }
      announce(empty)
      expect(lastRemoteCall()).toEqual([
        false,
        { config: glanceConfigForDemand(empty), workspaceId: "p1" },
      ])
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(publishMock).not.toHaveBeenCalled()
    })

    it("stores each build on the hub at once, stripped for the phone", async () => {
      settingsState.settings = {
        trayPanelLayout: {
          version: 1,
          preset: "usage-first",
          entries: layoutFromPreset("usage-first"),
        },
      }
      await mount()
      announce()
      const latest = glanceRemoteHub.getLatest(Date.now())
      expect(latest).toMatchObject({
        version: GLANCE_SNAPSHOT_VERSION,
        epoch: NOW,
        revision: 1,
        marker: "remote-body",
        actions: [],
        when: { goal: { active: true, paused: false } },
        hostLayout: { preset: "usage-first", entries: layoutFromPreset("usage-first") },
      })
      expect(latest?.when.goal).not.toHaveProperty("title")
      expect(publishMock).not.toHaveBeenCalled()
    })

    it("publishes the build on glance://update after the debounce", async () => {
      await mount()
      announce()
      await advance(GLANCE_PUSH_DEBOUNCE_MS - 1)
      expect(publishMock).not.toHaveBeenCalled()
      await advance(1)
      expect(publishMock).toHaveBeenCalledTimes(1)
      const [topic, snapshot] = publishMock.mock.calls[0]
      expect(topic).toBe("glance://update")
      expect(snapshot).toBe(glanceRemoteHub.getLatest(Date.now()))
    })

    it("coalesces a burst of remote changes into one publish of the newest build", async () => {
      await mount()
      announce()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      publishMock.mockClear()
      act(() => setRemoteSources(makeRemoteSources({}, "one")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      act(() => setRemoteSources(makeRemoteSources({}, "two")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      expect(publishMock).not.toHaveBeenCalled()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      expect(publishMock).toHaveBeenCalledTimes(1)
      expect(publishMock.mock.calls[0][1]).toMatchObject({ marker: "two", revision: 3 })
    })

    it("republishes when the tray layout changes, carrying the new host layout", async () => {
      await mount()
      announce()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      settingsState.settings = {
        trayPanelLayout: { version: 1, preset: "minimal", entries: layoutFromPreset("minimal") },
      }
      // The settings hook is read on render; a remote change re-renders.
      act(() => setRemoteSources(makeRemoteSources({}, "after-layout")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      expect(publishMock.mock.calls.at(-1)?.[1].hostLayout).toEqual({
        preset: "minimal",
        entries: layoutFromPreset("minimal"),
      })
    })

    it("shares the epoch with the tray build and counts its own revisions", async () => {
      await mount()
      subscribe(TRAY)
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      const tray = sendSnapshotMock.mock.calls[0][1]
      announce()
      act(() => setRemoteSources(makeRemoteSources({}, "again")))
      const latest = glanceRemoteHub.getLatest(Date.now())
      expect(latest?.epoch).toBe(tray.epoch)
      expect(latest?.revision).toBe(2)
    })

    it("drops the stored build and stops publishing when the last lease ends", async () => {
      await mount()
      announce()
      await advance(GLANCE_PUSH_DEBOUNCE_MS)
      publishMock.mockClear()
      endLease()
      expect(lastRemoteCall()?.[0]).toBe(false)
      glanceRemoteHub.announce(
        { consumer: "dev-B:phone-2", visible: true, demand: PHONE_DEMAND },
        NOW
      )
      expect(glanceRemoteHub.getLatest(NOW)).toBeNull()
      endLease("dev-B:phone-2")
      act(() => setRemoteSources(makeRemoteSources({}, "after-end")))
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(publishMock).not.toHaveBeenCalled()
    })

    it("cancels a pending publish when the lease ends first", async () => {
      await mount()
      announce()
      await advance(GLANCE_PUSH_DEBOUNCE_MS / 2)
      endLease()
      await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
      expect(publishMock).not.toHaveBeenCalled()
    })

    it("prunes a phone lease that lapsed on the sweep", async () => {
      await mount()
      announce()
      expect(lastRemoteCall()?.[0]).toBe(true)
      await advance(LEASE_TTL - GLANCE_PRUNE_INTERVAL_MS)
      expect(glanceRemoteHub.getDemandKey()).not.toBe("")
      await advance(GLANCE_PRUNE_INTERVAL_MS)
      expect(glanceRemoteHub.getDemandKey()).toBe("")
      expect(lastRemoteCall()?.[0]).toBe(false)
    })

    describe("executor", () => {
      it("is installed on mount and uninstalled on unmount", async () => {
        const { unmount } = await mount()
        expect(glanceRemoteHub.getExecutor()).not.toBeNull()
        unmount()
        expect(glanceRemoteHub.getExecutor()).toBeNull()
      })

      it("refresh re-reads quota over the phones' sources, not the tray's", async () => {
        const tray = makeSources()
        const remote = makeRemoteSources()
        act(() => setSources(tray))
        act(() => setRemoteSources(remote))
        await mount()
        await expect(glanceRemoteHub.getExecutor()!.refresh()).resolves.toBeNull()
        expect(remote.quota.refreshAll).toHaveBeenCalledTimes(1)
        expect(remote.refreshUsage).not.toHaveBeenCalled()
        expect(tray.quota.refreshAll).not.toHaveBeenCalled()
      })

      it("refresh also re-reads the usage index for an all-tools demand", async () => {
        const remote = makeRemoteSources({}, "all-tools", "all-tools")
        act(() => setRemoteSources(remote))
        await mount()
        await glanceRemoteHub.getExecutor()!.refresh()
        expect(remote.quota.refreshAll).toHaveBeenCalledTimes(1)
        expect(remote.refreshUsage).toHaveBeenCalledTimes(1)
      })

      it("refresh propagates a failure to the dispatcher", async () => {
        act(() =>
          setRemoteSources(
            makeRemoteSources({ refreshAll: jest.fn().mockRejectedValue(new Error("boom")) })
          )
        )
        await mount()
        await expect(glanceRemoteHub.getExecutor()!.refresh()).rejects.toThrow("boom")
      })

      it.each([
        [true, null],
        [false, "errors.quotaRefresh"],
      ])("quotaRefresh maps %s to %j", async (refreshed, expected) => {
        const remote = makeRemoteSources({ refreshOne: jest.fn().mockResolvedValue(refreshed) })
        act(() => setRemoteSources(remote))
        await mount()
        await expect(glanceRemoteHub.getExecutor()!.quotaRefresh("anthropic:a")).resolves.toBe(
          expected
        )
        expect(remote.quota.refreshOne).toHaveBeenCalledWith("anthropic:a")
      })

      it.each([
        [true, null],
        [false, "errors.quotaEnable"],
      ])("quotaEnable maps %s to %j", async (enabled, expected) => {
        const remote = makeRemoteSources({ enable: jest.fn().mockResolvedValue(enabled) })
        act(() => setRemoteSources(remote))
        await mount()
        await expect(glanceRemoteHub.getExecutor()!.quotaEnable("anthropic", "acc")).resolves.toBe(
          expected
        )
        expect(remote.quota.enable).toHaveBeenCalledWith("anthropic", "acc")
      })

      it("runs against the newest phones' sources", async () => {
        const stale = makeRemoteSources()
        act(() => setRemoteSources(stale))
        await mount()
        const fresh = makeRemoteSources()
        act(() => setRemoteSources(fresh))
        await glanceRemoteHub.getExecutor()!.refresh()
        expect(fresh.quota.refreshAll).toHaveBeenCalledTimes(1)
        expect(stale.quota.refreshAll).not.toHaveBeenCalled()
      })
    })

    it.each([
      ["outside Tauri", () => isTauriMock.mockReturnValue(false)],
      ["in a secondary window", () => mainWindowMock.mockReturnValue(false)],
    ])("does none of this %s", async (_name, arrange) => {
      arrange()
      const setLatest = jest.spyOn(glanceRemoteHub, "setLatest")
      try {
        await mount()
        expect(glanceRemoteHub.getExecutor()).toBeNull()
        announce()
        await advance(GLANCE_PUSH_DEBOUNCE_MS * 3)
        expect(setLatest).not.toHaveBeenCalled()
        expect(publishMock).not.toHaveBeenCalled()
        expect(glanceRemoteHub.getLatest(Date.now())).toBeNull()
        // No sweep either: the lease is still on the hub past its TTL until
        // something else prunes it.
        await advance(LEASE_TTL + GLANCE_PRUNE_INTERVAL_MS)
        expect(glanceRemoteHub.getDemandKey()).not.toBe("")
      } finally {
        setLatest.mockRestore()
      }
    })
  })
})

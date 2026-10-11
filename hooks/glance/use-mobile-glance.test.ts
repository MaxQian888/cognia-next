import { act, renderHook } from "@testing-library/react"

import type { GlancePhoneState } from "@/lib/glance/remote/phone-store"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceMobileSettings } from "@/types/glance/layout"

jest.mock("./use-glance-sources", () => ({ useGlanceSources: jest.fn() }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({ useRuntimeSnapshot: jest.fn() }))
jest.mock("@/hooks/pet/use-document-visible", () => ({ useDocumentHidden: jest.fn() }))
jest.mock("@/lib/pet/remote/client", () => ({ createPetRemoteClient: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ transport: { marker: "transport" } }))
jest.mock("@/lib/glance/plugin-actions", () => ({ runGlancePluginAction: jest.fn() }))
jest.mock("@/stores/settings", () => {
  const state = {
    settings: {} as Record<string, unknown> | null,
    save: jest.fn(),
  }
  return {
    useSettingsStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("@/stores/project/project-store", () => {
  const state = { activeProjectId: null as string | null }
  return {
    useProjectStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("@/lib/glance/remote/phone-store", () => {
  const idle = { status: "idle", snapshot: null, receivedAt: null, hostLabel: null }
  let state: unknown = idle
  const listeners = new Set<() => void>()
  const release = jest.fn()
  return {
    glancePhoneStore: {
      hold: jest.fn(() => release),
      setDemand: jest.fn(),
      request: jest.fn(),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getState: () => state,
    },
    __release: release,
    __setState: (next: unknown) => {
      state = next
      listeners.forEach((listener) => listener())
    },
    __idle: idle,
  }
})

import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { withEditedMobileEntries, withMobilePreset } from "@/lib/glance/layout-edit"
import {
  DEFAULT_GLANCE_MOBILE_SETTINGS,
  migrateMobileHomeLayout,
  mobileLayoutFromPreset,
} from "@/lib/glance/mobile-layout"
import { DEFAULT_GLANCE_PANEL_SETTINGS, layoutFromPreset } from "@/lib/glance/presets"
import * as phoneStoreModule from "@/lib/glance/remote/phone-store"
import { glanceDemandOf } from "@/lib/glance/remote/demand"
import { neededEntries, phoneLocalConfig } from "@/lib/glance/remote/phone-view"
import { createPetRemoteClient } from "@/lib/pet/remote/client"
import { runGlancePluginAction } from "@/lib/glance/plugin-actions"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

import { useGlanceSources } from "./use-glance-sources"
import { pinnedLayout, useMobileGlance, type UseMobileGlanceOptions } from "./use-mobile-glance"

const sourcesMock = useGlanceSources as jest.Mock
const runtimeMock = useRuntimeSnapshot as jest.Mock
const hiddenMock = useDocumentHidden as jest.Mock
const petClientMock = createPetRemoteClient as jest.Mock
const phoneStore = phoneStoreModule.glancePhoneStore as unknown as {
  hold: jest.Mock
  setDemand: jest.Mock
  request: jest.Mock
}
const phoneInternals = phoneStoreModule as unknown as {
  __release: jest.Mock
  __setState: (next: unknown) => void
  __idle: GlancePhoneState
}
const settingsState = (
  useSettingsStore as unknown as {
    getState: () => { settings: Record<string, unknown> | null; save: jest.Mock }
  }
).getState()
const projectState = (
  useProjectStore as unknown as { getState: () => { activeProjectId: string | null } }
).getState()

const NOW = 1_900_000_000_000

const STANDALONE = { target: { kind: "local" }, host: null }
const pairedRuntime = (
  operations: string[] = ["glance_subscribe", "pet_act"],
  compatible = true
) => ({
  target: { kind: "companion" },
  host: { compatible, operations },
})

const slice = (tag: string) => ({ tag }) as never

function localBody() {
  return {
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: { marker: "when" },
    actions: [],
    fleet: slice("local-fleet"),
    usage: slice("local-usage"),
    quota: slice("local-quota"),
    agenda: slice("local-agenda"),
    activity: slice("local-activity"),
    recents: slice("local-recents"),
    pet: slice("local-pet"),
  }
}

function remoteSnapshot(): GlanceSnapshotV1 {
  return {
    ...localBody(),
    version: 1,
    epoch: 9,
    revision: 4,
    generatedAt: NOW - 1000,
    fleet: slice("host-fleet"),
    usage: slice("host-usage"),
    quota: slice("host-quota"),
    agenda: slice("host-agenda"),
    activity: slice("host-activity"),
    recents: slice("host-recents"),
    pet: slice("host-pet"),
    hostLayout: { preset: "minimal", entries: layoutFromPreset("minimal") },
  } as unknown as GlanceSnapshotV1
}

describe("useMobileGlance", () => {
  let quota: { refreshAll: jest.Mock; refreshOne: jest.Mock; enable: jest.Mock }
  let navigate: jest.Mock
  let openSession: jest.Mock
  let editShortcuts: jest.Mock
  let onRouted: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    quota = {
      refreshAll: jest.fn().mockResolvedValue(undefined),
      refreshOne: jest.fn().mockResolvedValue(true),
      enable: jest.fn().mockResolvedValue(true),
    }
    const body = localBody()
    sourcesMock.mockImplementation(() => ({ body, quota, refreshUsage: jest.fn() }))
    runtimeMock.mockReturnValue(STANDALONE)
    hiddenMock.mockReturnValue(false)
    settingsState.settings = {}
    settingsState.save.mockReset()
    settingsState.save.mockResolvedValue(undefined)
    projectState.activeProjectId = null
    phoneStore.request.mockResolvedValue(null)
    act(() => phoneInternals.__setState(phoneInternals.__idle))
    navigate = jest.fn()
    openSession = jest.fn()
    editShortcuts = jest.fn()
    onRouted = jest.fn()
  })

  type Props = Pick<UseMobileGlanceOptions, "drawerOpen" | "homeVisible">

  function render(props: Props = { drawerOpen: false, homeVisible: true }) {
    return renderHook(
      ({ drawerOpen, homeVisible }: Props) =>
        useMobileGlance({
          drawerOpen,
          homeVisible,
          navigate,
          openSession,
          editShortcuts,
          onRouted,
        }),
      { initialProps: props }
    )
  }

  function lastSourcesCall() {
    const call = sourcesMock.mock.calls.at(-1)!
    return {
      active: call[0] as boolean,
      config: call[1].config as typeof DEFAULT_GLANCE_PANEL_SETTINGS,
      workspaceId: call[1].workspaceId as string | null,
    }
  }

  const visibleIds = (entries: readonly { id: string; hidden: boolean }[]) =>
    entries.filter((e) => !e.hidden).map((e) => e.id)

  describe("settings", () => {
    it("reads the legacy home model when no glance layout is stored", () => {
      settingsState.settings = {
        mobileHomeLayout: { quickActions: ["inbox"], hiddenSections: ["recents"] },
        welcomeStats: { enabled: false },
      }
      const { result } = render()
      expect(result.current.settings).toEqual(
        migrateMobileHomeLayout({
          mobileHomeLayout: { quickActions: ["inbox"], hiddenSections: ["recents"] },
          welcomeStats: { enabled: false },
        })
      )
      expect(result.current.settings.preset).toBe("custom")
      expect(settingsState.save).not.toHaveBeenCalled()
    })

    it("prefers a stored glance layout over the legacy home", () => {
      settingsState.settings = {
        mobileGlanceLayout: { preset: "minimal", entries: mobileLayoutFromPreset("minimal") },
        mobileHomeLayout: { hiddenSections: ["activeRuns"] },
      }
      const { result } = render()
      expect(result.current.settings.preset).toBe("minimal")
      expect(result.current.settings.entries).toEqual(mobileLayoutFromPreset("minimal"))
    })

    it("defaults with settings not loaded", () => {
      settingsState.settings = null
      const { result } = render()
      expect(result.current.settings).toEqual(DEFAULT_GLANCE_MOBILE_SETTINGS)
    })
  })

  describe("what is built", () => {
    it("builds nothing while neither surface is on screen", () => {
      runtimeMock.mockReturnValue(pairedRuntime())
      render({ drawerOpen: false, homeVisible: false })
      const call = lastSourcesCall()
      expect(call.active).toBe(false)
      expect(visibleIds(call.config.entries)).toEqual([])
      expect(phoneStore.hold).not.toHaveBeenCalled()
    })

    it("builds the pinned modules for the home screen", () => {
      render({ drawerOpen: false, homeVisible: true })
      const call = lastSourcesCall()
      expect(call.active).toBe(true)
      expect(visibleIds(call.config.entries)).toEqual([
        "fleet",
        "quick",
        "usage",
        "activity",
        "recents",
      ])
      expect(call.config).toEqual(
        phoneLocalConfig(
          DEFAULT_GLANCE_MOBILE_SETTINGS,
          neededEntries(DEFAULT_GLANCE_MOBILE_SETTINGS.entries, false),
          false
        )
      )
    })

    it("builds every visible module while the drawer is open", () => {
      render({ drawerOpen: true, homeVisible: false })
      expect(visibleIds(lastSourcesCall().config.entries)).toEqual([
        "fleet",
        "quick",
        "usage",
        "activity",
        "recents",
        "quota",
        "agenda",
      ])
    })

    it("builds nothing while the app is in the background", () => {
      hiddenMock.mockReturnValue(true)
      runtimeMock.mockReturnValue(pairedRuntime())
      render({ drawerOpen: true, homeVisible: true })
      expect(lastSourcesCall().active).toBe(false)
      expect(phoneStore.hold).not.toHaveBeenCalled()
    })

    it("builds only the local modules when paired", () => {
      runtimeMock.mockReturnValue(pairedRuntime())
      render({ drawerOpen: true, homeVisible: false })
      expect(visibleIds(lastSourcesCall().config.entries)).toEqual(["quick", "recents"])
    })

    it("hands the active project to the phone's own build", () => {
      projectState.activeProjectId = "p1"
      render()
      expect(lastSourcesCall().workspaceId).toBe("p1")
    })
  })

  describe("paired link", () => {
    it("is standalone off a companion target", () => {
      const { result } = render()
      expect(result.current.paired).toBe(false)
      expect(result.current.supported).toBe(false)
    })

    it("is supported when the host advertises glance_subscribe", () => {
      runtimeMock.mockReturnValue(pairedRuntime())
      const { result } = render()
      expect(result.current.paired).toBe(true)
      expect(result.current.supported).toBe(true)
    })

    it.each([
      ["lacks the operation", pairedRuntime(["pet_act"])],
      ["is incompatible", pairedRuntime(["glance_subscribe"], false)],
    ])("is unsupported when the host %s, and holds nothing", (_name, runtime) => {
      runtimeMock.mockReturnValue(runtime)
      const { result } = render({ drawerOpen: true, homeVisible: true })
      expect(result.current.supported).toBe(false)
      expect(phoneStore.hold).not.toHaveBeenCalled()
      expect(result.current.originOf("usage")).toEqual({
        kind: "unavailable",
        reason: "host-unsupported",
      })
    })

    it("is undecided until the host manifest arrives, and holds nothing", () => {
      runtimeMock.mockReturnValue({ target: { kind: "companion" }, host: null })
      const { result } = render({ drawerOpen: true, homeVisible: true })
      expect(result.current.supported).toBeNull()
      expect(phoneStore.hold).not.toHaveBeenCalled()
    })
  })

  describe("lease", () => {
    beforeEach(() => {
      runtimeMock.mockReturnValue(pairedRuntime())
    })

    it("holds the lease with the demand of what is on screen", () => {
      render({ drawerOpen: false, homeVisible: true })
      const expected = glanceDemandOf(
        DEFAULT_GLANCE_MOBILE_SETTINGS,
        neededEntries(DEFAULT_GLANCE_MOBILE_SETTINGS.entries, false),
        null
      )
      expect(phoneStore.hold).toHaveBeenCalledTimes(1)
      expect(phoneStore.hold).toHaveBeenCalledWith(expected)
      expect(expected.modules).toEqual(["fleet", "usage", "activity"])
    })

    it("carries the workspace in the demand when the layout is scoped", () => {
      projectState.activeProjectId = "p1"
      settingsState.settings = {
        mobileGlanceLayout: { ...DEFAULT_GLANCE_MOBILE_SETTINGS, scope: "workspace" },
      }
      render()
      expect(phoneStore.hold.mock.calls[0][0]).toMatchObject({
        scope: "workspace",
        workspaceId: "p1",
      })
    })

    it("changes the demand in place when the drawer opens, without re-holding", () => {
      const { rerender } = render({ drawerOpen: false, homeVisible: true })
      expect(phoneStore.hold).toHaveBeenCalledTimes(1)
      rerender({ drawerOpen: true, homeVisible: true })
      expect(phoneStore.hold).toHaveBeenCalledTimes(1)
      expect(phoneInternals.__release).not.toHaveBeenCalled()
      expect(phoneStore.setDemand).toHaveBeenLastCalledWith(
        glanceDemandOf(
          DEFAULT_GLANCE_MOBILE_SETTINGS,
          neededEntries(DEFAULT_GLANCE_MOBILE_SETTINGS.entries, true),
          null
        )
      )
      expect(phoneStore.setDemand.mock.calls.at(-1)![0].modules).toEqual([
        "fleet",
        "usage",
        "activity",
        "quota",
        "agenda",
      ])
    })

    it("does not set a demand again on a re-render with the same demand", () => {
      const { rerender } = render()
      const calls = phoneStore.setDemand.mock.calls.length
      rerender({ drawerOpen: false, homeVisible: true })
      expect(phoneStore.setDemand).toHaveBeenCalledTimes(calls)
    })

    it("releases on unmount", () => {
      const { unmount } = render()
      unmount()
      expect(phoneInternals.__release).toHaveBeenCalledTimes(1)
    })

    it("releases when nothing host-sourced is on screen any more", () => {
      const { rerender } = render({ drawerOpen: true, homeVisible: true })
      rerender({ drawerOpen: false, homeVisible: false })
      expect(phoneInternals.__release).toHaveBeenCalledTimes(1)
      const setCalls = phoneStore.setDemand.mock.calls.length
      rerender({ drawerOpen: false, homeVisible: false })
      expect(phoneStore.setDemand).toHaveBeenCalledTimes(setCalls)
    })

    it("releases when the app goes to the background and holds again on return", () => {
      const { rerender } = render()
      hiddenMock.mockReturnValue(true)
      rerender({ drawerOpen: false, homeVisible: true })
      expect(phoneInternals.__release).toHaveBeenCalledTimes(1)
      hiddenMock.mockReturnValue(false)
      rerender({ drawerOpen: false, homeVisible: true })
      expect(phoneStore.hold).toHaveBeenCalledTimes(2)
    })

    it("holds nothing when only local modules are on screen", () => {
      settingsState.settings = {
        mobileGlanceLayout: {
          ...DEFAULT_GLANCE_MOBILE_SETTINGS,
          entries: mobileLayoutFromPreset("balanced").map((e) => ({
            ...e,
            home: e.id === "recents" || e.id === "quick",
          })),
        },
      }
      render({ drawerOpen: false, homeVisible: true })
      expect(phoneStore.hold).not.toHaveBeenCalled()
    })

    it("holds nothing on a standalone phone", () => {
      runtimeMock.mockReturnValue(STANDALONE)
      render({ drawerOpen: true, homeVisible: true })
      expect(phoneStore.hold).not.toHaveBeenCalled()
      expect(phoneStore.setDemand).not.toHaveBeenCalled()
    })
  })

  describe("snapshot", () => {
    it("is the local build on a standalone phone, versioned", () => {
      const { result } = render()
      expect(result.current.glance.snapshot).toMatchObject({
        version: 1,
        epoch: 0,
        revision: 0,
        fleet: { tag: "local-fleet" },
        usage: { tag: "local-usage" },
        recents: { tag: "local-recents" },
      })
      expect(result.current.glance).toMatchObject({
        platform: "mobile",
        width: "standard",
        now: NOW,
      })
    })

    it("takes the host-sourced slices from the desktop when paired", () => {
      runtimeMock.mockReturnValue(pairedRuntime())
      const { result } = render()
      // Nothing received yet: the host slices are empty, recents stay local.
      expect(result.current.glance.snapshot.usage).toBeNull()
      expect(result.current.glance.snapshot.recents).toEqual({ tag: "local-recents" })

      act(() =>
        phoneInternals.__setState({
          status: "live",
          snapshot: remoteSnapshot(),
          receivedAt: NOW - 500,
          hostLabel: "Studio Mac",
        })
      )
      const snap = result.current.glance.snapshot
      for (const id of ["fleet", "usage", "quota", "agenda", "activity", "pet"] as const) {
        expect(snap[id]).toEqual({ tag: `host-${id}` })
      }
      expect(snap.recents).toEqual({ tag: "local-recents" })
      expect(snap.when).toEqual({ marker: "when" })
      expect(result.current.remote.status).toBe("live")
      expect(result.current.hostLayout).toEqual({
        preset: "minimal",
        entries: layoutFromPreset("minimal"),
      })
      expect(result.current.originOf("usage")).toEqual({
        kind: "host",
        host: "Studio Mac",
        at: NOW - 500,
        live: true,
      })
      expect(result.current.glance.originOf?.("recents")).toBeNull()
    })

    it("has no host layout before anything arrived", () => {
      const { result } = render()
      expect(result.current.hostLayout).toBeNull()
    })
  })

  describe("send", () => {
    async function send(body: GlanceRequestBody, props?: Props) {
      const { result } = render(props)
      let out: string | null | undefined
      await act(async () => {
        out = await result.current.glance.send(body)
      })
      return { out, result }
    }

    const saved = (): GlanceMobileSettings =>
      settingsState.save.mock.calls.at(-1)![0].mobileGlanceLayout

    describe("routes", () => {
      it("open-fleet navigates to the phone's Fleet page", async () => {
        const { out } = await send({ kind: "open-fleet", rowId: "r1" })
        expect(out).toBeNull()
        expect(navigate).toHaveBeenCalledWith("/fleet")
        expect(onRouted).toHaveBeenCalledTimes(1)
      })

      it("open-owner navigates to the owner's phone route", async () => {
        await send({ kind: "open-owner", owner: "usage" })
        expect(navigate).toHaveBeenCalledWith("/me/subscription?subTab=usage")
        expect(onRouted).toHaveBeenCalledTimes(1)
      })

      it("open-owner for the tray actions opens the shortcut editor", async () => {
        await send({ kind: "open-owner", owner: "tray-actions" })
        expect(editShortcuts).toHaveBeenCalledTimes(1)
        expect(navigate).not.toHaveBeenCalled()
        expect(onRouted).toHaveBeenCalledTimes(1)
      })

      it("open-session resumes the conversation", async () => {
        await send({ kind: "open-session", sessionId: "s1" })
        expect(openSession).toHaveBeenCalledWith("s1")
        expect(onRouted).toHaveBeenCalledTimes(1)
      })

      it("route ignores a request that is not a route", () => {
        const { result } = render()
        act(() => result.current.glance.route({ kind: "refresh" }))
        expect(navigate).not.toHaveBeenCalled()
        expect(onRouted).not.toHaveBeenCalled()
      })

      it("route works without an onRouted callback", () => {
        const { result } = renderHook(() =>
          useMobileGlance({
            drawerOpen: false,
            homeVisible: true,
            navigate,
            openSession,
            editShortcuts,
          })
        )
        act(() => result.current.glance.route({ kind: "open-owner", owner: "pet" }))
        expect(navigate).toHaveBeenCalledWith("/pet")
      })
    })

    describe("refreshes on a standalone phone", () => {
      it("refresh re-reads local quota", async () => {
        const { out } = await send({ kind: "refresh" })
        expect(out).toBeNull()
        expect(quota.refreshAll).toHaveBeenCalledTimes(1)
        expect(phoneStore.request).not.toHaveBeenCalled()
      })

      it("quota-refresh maps the local result", async () => {
        expect((await send({ kind: "quota-refresh", key: "k" })).out).toBeNull()
        expect(quota.refreshOne).toHaveBeenCalledWith("k")
        quota.refreshOne.mockResolvedValue(false)
        expect((await send({ kind: "quota-refresh", key: "k" })).out).toBe("errors.quotaRefresh")
      })

      it("quota-enable maps the local result", async () => {
        expect((await send({ kind: "quota-enable", provider: "p", accountId: "a" })).out).toBeNull()
        expect(quota.enable).toHaveBeenCalledWith("p", "a")
        quota.enable.mockResolvedValue(false)
        expect((await send({ kind: "quota-enable", provider: "p", accountId: "a" })).out).toBe(
          "errors.quotaEnable"
        )
      })
    })

    describe("refreshes on a paired phone", () => {
      beforeEach(() => runtimeMock.mockReturnValue(pairedRuntime()))

      it("refresh goes to the desktop", async () => {
        phoneStore.request.mockResolvedValue("errors.hostUnavailable")
        const { out } = await send({ kind: "refresh" })
        expect(out).toBe("errors.hostUnavailable")
        expect(phoneStore.request).toHaveBeenCalledWith({ kind: "refresh" })
        expect(quota.refreshAll).not.toHaveBeenCalled()
      })

      it("quota-refresh and quota-enable go to the desktop", async () => {
        await send({ kind: "quota-refresh", key: "k" })
        expect(phoneStore.request).toHaveBeenLastCalledWith({ kind: "quota-refresh", key: "k" })
        await send({ kind: "quota-enable", provider: "p", accountId: "a" })
        expect(phoneStore.request).toHaveBeenLastCalledWith({
          kind: "quota-enable",
          provider: "p",
          accountId: "a",
        })
        expect(quota.refreshOne).not.toHaveBeenCalled()
        expect(quota.enable).not.toHaveBeenCalled()
      })

      it("stays local when the desktop does not serve glance", async () => {
        runtimeMock.mockReturnValue(pairedRuntime(["pet_act"]))
        await send({ kind: "refresh" })
        expect(quota.refreshAll).toHaveBeenCalledTimes(1)
        expect(phoneStore.request).not.toHaveBeenCalled()
      })
    })

    describe("layout writes", () => {
      it.each([
        [{ kind: "set-scope", scope: "workspace" }, { scope: "workspace" }],
        [
          { kind: "set-usage-scope", scope: "all-tools" },
          {
            options: { usage: { scope: "all-tools", showSpend: false }, activity: { range: "3m" } },
          },
        ],
        [
          { kind: "set-show-spend", showSpend: true },
          { options: { usage: { scope: "cognia", showSpend: true }, activity: { range: "3m" } } },
        ],
        [
          { kind: "set-activity-range", range: "1y" },
          { options: { usage: { scope: "cognia", showSpend: false }, activity: { range: "1y" } } },
        ],
      ] as const)("%j saves the patched mobile layout", async (body, patch) => {
        const { out } = await send(body as GlanceRequestBody)
        expect(out).toBeNull()
        expect(settingsState.save).toHaveBeenCalledTimes(1)
        expect(settingsState.save).toHaveBeenCalledWith({
          mobileGlanceLayout: { ...DEFAULT_GLANCE_MOBILE_SETTINGS, ...patch },
        })
      })

      it("set-usage-scope keeps showSpend", async () => {
        settingsState.settings = {
          mobileGlanceLayout: {
            ...DEFAULT_GLANCE_MOBILE_SETTINGS,
            options: { usage: { scope: "cognia", showSpend: true }, activity: { range: "1m" } },
          },
        }
        await send({ kind: "set-usage-scope", scope: "all-tools" })
        expect(saved().options).toEqual({
          usage: { scope: "all-tools", showSpend: true },
          activity: { range: "1m" },
        })
      })

      it("set-layout keeps each module's home pin, never pinning a hidden one", async () => {
        const entries = [
          { id: "usage", size: "expanded", hidden: false },
          { id: "quota", size: "standard", hidden: false },
          { id: "fleet", size: "compact", hidden: true },
          { id: "recents", size: "standard", hidden: false },
        ] as const
        await send({ kind: "set-layout", entries: [...entries] })
        const out = saved()
        expect(out.preset).toBe("custom")
        expect(out.entries.slice(0, 4)).toEqual([
          { id: "usage", size: "expanded", hidden: false, home: true },
          { id: "quota", size: "standard", hidden: false, home: false },
          { id: "fleet", size: "compact", hidden: true, home: false },
          { id: "recents", size: "standard", hidden: false, home: true },
        ])
        expect(out.shortcuts).toEqual(DEFAULT_GLANCE_MOBILE_SETTINGS.shortcuts)
        expect(out).toEqual(
          withEditedMobileEntries(
            DEFAULT_GLANCE_MOBILE_SETTINGS,
            out.entries.map((e) => ({ ...e }))
          )
        )
      })

      it("apply-preset saves the phone's preset, keeping shortcuts", async () => {
        settingsState.settings = {
          mobileGlanceLayout: { ...DEFAULT_GLANCE_MOBILE_SETTINGS, shortcuts: ["me"] },
        }
        await send({ kind: "apply-preset", preset: "agent-ops" })
        expect(saved()).toEqual(
          withMobilePreset({ ...DEFAULT_GLANCE_MOBILE_SETTINGS, shortcuts: ["me"] }, "agent-ops")
        )
        expect(saved().shortcuts).toEqual(["me"])
      })

      it("a legacy phone's first edit stores the migrated layout", async () => {
        settingsState.settings = { mobileHomeLayout: { hiddenSections: ["recents"] } }
        await send({ kind: "set-scope", scope: "workspace" })
        expect(saved()).toEqual({
          ...migrateMobileHomeLayout({ mobileHomeLayout: { hiddenSections: ["recents"] } }),
          scope: "workspace",
        })
      })

      it("resolves errors.requestFailed when the save fails", async () => {
        settingsState.save.mockRejectedValue(new Error("disk"))
        expect((await send({ kind: "set-scope", scope: "all" })).out).toBe("errors.requestFailed")
      })

      it.each([
        { kind: "set-width", width: "wide" },
        { kind: "set-max-height", maxHeight: 400 },
        { kind: "set-delegate-visible", visible: false },
      ] as const)("refuses the tray-only %j", async (body) => {
        expect((await send(body)).out).toBe("errors.requestFailed")
        expect(settingsState.save).not.toHaveBeenCalled()
      })
    })

    describe("pet care", () => {
      it("is unavailable on a standalone phone", async () => {
        expect((await send({ kind: "pet-care", command: "pet.feed" })).out).toBe(
          "errors.commandUnavailable"
        )
        expect(petClientMock).not.toHaveBeenCalled()
      })

      it("is unavailable when the host lacks pet_act", async () => {
        runtimeMock.mockReturnValue(pairedRuntime(["glance_subscribe"]))
        expect((await send({ kind: "pet-care", command: "pet.feed" })).out).toBe(
          "errors.commandUnavailable"
        )
        expect(petClientMock).not.toHaveBeenCalled()
      })

      it.each([
        ["pet.feed", "fed"],
        ["pet.play", "played"],
        ["pet.pet", "petted"],
        ["pet.sleep", "slept"],
        ["pet.clean", "cleaned"],
      ] as const)("%s acts %s through the pet remote client", async (command, kind) => {
        runtimeMock.mockReturnValue(pairedRuntime())
        const actMock = jest.fn().mockResolvedValue({ ok: true })
        petClientMock.mockReturnValue({ act: actMock })
        expect((await send({ kind: "pet-care", command })).out).toBeNull()
        expect(petClientMock).toHaveBeenCalledWith({ marker: "transport" })
        expect(actMock).toHaveBeenCalledWith(kind)
      })

      it("maps a refused act to errors.commandUnavailable", async () => {
        runtimeMock.mockReturnValue(pairedRuntime())
        petClientMock.mockReturnValue({ act: jest.fn().mockResolvedValue({ ok: false }) })
        expect((await send({ kind: "pet-care", command: "pet.feed" })).out).toBe(
          "errors.commandUnavailable"
        )
      })

      it("maps a failed act to errors.hostUnreachable", async () => {
        runtimeMock.mockReturnValue(pairedRuntime())
        petClientMock.mockReturnValue({ act: jest.fn().mockRejectedValue(new Error("offline")) })
        expect((await send({ kind: "pet-care", command: "pet.feed" })).out).toBe(
          "errors.hostUnreachable"
        )
      })
    })
  })

  describe("save", () => {
    it("stores the layout and resolves null", async () => {
      const { result } = render()
      const next = { ...DEFAULT_GLANCE_MOBILE_SETTINGS, preset: "minimal" as const }
      let out: string | null = "unset"
      await act(async () => {
        out = await result.current.save(next)
      })
      expect(out).toBeNull()
      expect(settingsState.save).toHaveBeenCalledWith({ mobileGlanceLayout: next })
    })

    it("resolves errors.requestFailed when the store rejects", async () => {
      settingsState.save.mockRejectedValue(new Error("quota"))
      const { result } = render()
      let out: string | null = null
      await act(async () => {
        out = await result.current.save(DEFAULT_GLANCE_MOBILE_SETTINGS)
      })
      expect(out).toBe("errors.requestFailed")
    })
  })
  describe("plugin modules (ADR-0225 §6)", () => {
    const PLUGINS = {
      updatedAt: NOW,
      catalog: [
        {
          id: "plugin:com.ci:status",
          pluginId: "com.ci",
          title: "CI",
          icon: null,
          sizes: ["compact"],
          platforms: ["mobile"],
        },
      ],
      modules: {},
    }
    const runActionMock = runGlancePluginAction as jest.Mock

    function renderEditor(editorOpen: boolean) {
      return renderHook(
        ({ open }: { open: boolean }) =>
          useMobileGlance({
            drawerOpen: false,
            homeVisible: false,
            editorOpen: open,
            navigate,
            openSession,
            editShortcuts,
            onRouted,
          }),
        { initialProps: { open: editorOpen } }
      )
    }

    it("builds the phone's own slices for the mobile platform", () => {
      render()
      expect(sourcesMock.mock.calls.at(-1)?.[1].platform).toBe("mobile")
    })

    it("holds a lease for the desktop's plugin catalogue while a paired phone edits", () => {
      runtimeMock.mockReturnValue(pairedRuntime())
      const { rerender } = renderEditor(false)
      expect(phoneStore.hold).not.toHaveBeenCalled()
      rerender({ open: true })
      expect(phoneStore.hold).toHaveBeenCalledWith(
        expect.objectContaining({ modules: [], catalog: true })
      )
    })

    it("never asks for a catalogue when standalone", () => {
      renderEditor(true)
      expect(phoneStore.hold).not.toHaveBeenCalled()
    })

    it("offers the desktop's catalogue when paired and its own when standalone", () => {
      const body = { ...localBody(), plugins: { ...PLUGINS, catalog: [] } }
      sourcesMock.mockImplementation(() => ({ body, quota, refreshUsage: jest.fn() }))
      expect(render().result.current.pluginCatalog).toEqual([])

      runtimeMock.mockReturnValue(pairedRuntime())
      act(() =>
        phoneInternals.__setState({
          status: "live",
          snapshot: { ...remoteSnapshot(), plugins: PLUGINS },
          receivedAt: NOW,
          hostLabel: "Mac",
        })
      )
      expect(render().result.current.pluginCatalog).toEqual(PLUGINS.catalog)
    })

    it("runs a plugin action on a standalone phone and refuses it on a paired one", async () => {
      runActionMock.mockResolvedValue(null)
      const standalone = render()
      await expect(
        standalone.result.current.glance.send({
          kind: "plugin-action",
          entryId: "plugin:com.ci:status",
          actionId: "open",
        })
      ).resolves.toBeNull()
      expect(runActionMock).toHaveBeenCalledWith("plugin:com.ci:status", "open")

      runActionMock.mockClear()
      runtimeMock.mockReturnValue(pairedRuntime())
      const paired = render()
      await expect(
        paired.result.current.glance.send({
          kind: "plugin-action",
          entryId: "plugin:com.ci:status",
          actionId: "open",
        })
      ).resolves.toBe("errors.commandUnavailable")
      expect(runActionMock).not.toHaveBeenCalled()
    })

    it("pins a plugin module that is running, and not one that is not", () => {
      const settings = {
        ...DEFAULT_GLANCE_MOBILE_SETTINGS,
        entries: [
          ...DEFAULT_GLANCE_MOBILE_SETTINGS.entries,
          {
            id: "plugin:com.ci:status" as const,
            size: "compact" as const,
            hidden: true,
            home: false,
          },
        ],
      }
      const pinned = pinnedLayout(settings, "plugin:com.ci:status", true, ["plugin:com.ci:status"])
      expect(pinned.entries.find((e) => e.id === "plugin:com.ci:status")).toMatchObject({
        hidden: false,
        home: true,
      })
      const refused = pinnedLayout(settings, "plugin:com.ci:status", true)
      expect(refused.entries.find((e) => e.id === "plugin:com.ci:status")?.home).toBe(false)
    })
  })
})

describe("pinnedLayout", () => {
  it("pins a hidden module, showing it, and makes the layout custom", () => {
    const out = pinnedLayout(DEFAULT_GLANCE_MOBILE_SETTINGS, "pet", true)
    expect(out.preset).toBe("custom")
    expect(out.entries.find((e) => e.id === "pet")).toMatchObject({ hidden: false, home: true })
  })

  it("unpins a module, keeping it visible in the drawer", () => {
    const out = pinnedLayout(DEFAULT_GLANCE_MOBILE_SETTINGS, "usage", false)
    expect(out.entries.find((e) => e.id === "usage")).toMatchObject({ hidden: false, home: false })
    expect(out.shortcuts).toEqual(DEFAULT_GLANCE_MOBILE_SETTINGS.shortcuts)
  })
})

/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { ChatDockSurface } from "./chat-dock-surface"
import { useDockLayoutStore } from "@/stores/dock/dock-layout-store"
import {
  LEGACY_ARTIFACT_DOCK_KEY,
  LEGACY_CONTEXT_WORKBENCH_KEY,
} from "@/lib/dock/migrate-legacy-layout"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { dockLayoutKeyOf } from "@/types/dock/layout"
import {
  CONTEXT_ACTIVITY_RAIL_ORDER,
  type ContextPanelDefinition,
  type ContextResource,
} from "@/types/context-workbench"
import type { DockHostProps } from "@/components/dock/dock-host"

// `DockHost` is the kernel and has its own suite; what matters here is the
// contract this surface hands it — which layout, which panels, which rail.
const hostProps: DockHostProps[] = []
jest.mock("@/components/dock/dock-host", () => ({
  DockHost: (props: DockHostProps) => {
    hostProps.push(props)
    return <div data-testid="dock-host" data-rail-only={props.railOnly ? "true" : "false"} />
  },
}))

let storedRailLayout: unknown
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: { settings: unknown }) => unknown) =>
    selector({ settings: { workbenchRail: storedRailLayout } }),
}))

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

function panel(id: string, activity: ContextPanelDefinition["activity"]): ContextPanelDefinition {
  return { id, activity, labelKey: `x.${id}`, appliesTo: () => true, renderer }
}

const PANELS = [
  panel("browser", "preview-run"),
  panel("artifacts", "review"),
  panel("workspace", "workspace"),
]

const RESOURCE: ContextResource = {
  kind: "session",
  sessionId: "sess-1",
  capabilities: ["workspace"],
}

const KEY = { accountId: DEFAULT_LOCAL_ACCOUNT_ID, host: "chat" as const, contextId: "sess-1" }

function renderSurface(overrides: Partial<Parameters<typeof ChatDockSurface>[0]> = {}) {
  return render(
    <ChatDockSurface
      workbenchInstanceId="wb"
      resource={RESOURCE}
      panels={PANELS}
      contextId="sess-1"
      legacyScopeKey="wb::session:sess-1"
      {...overrides}
    />
  )
}

const layoutOf = () => useDockLayoutStore.getState().envelopes[dockLayoutKeyOf(KEY)]

beforeEach(() => {
  hostProps.length = 0
  storedRailLayout = undefined
  window.localStorage.clear()
  useDockLayoutStore.setState({ envelopes: {} })
})

describe("ChatDockSurface", () => {
  it("scopes the layout to the conversation under the active account", () => {
    renderSurface()
    expect(screen.getByTestId("dock-host")).toBeInTheDocument()
    expect(hostProps[0]?.layoutKey).toEqual(KEY)
    expect(hostProps[0]?.panels).toBe(PANELS)
    expect(hostProps[0]?.resource).toBe(RESOURCE)
    expect(hostProps[0]?.workbenchInstanceId).toBe("wb")
  })

  it("passes rail-only through so a collapsed dock unmounts its grid", () => {
    renderSurface({ railOnly: true })
    expect(screen.getByTestId("dock-host")).toHaveAttribute("data-rail-only", "true")
  })

  it("gives the kernel the app's own rail order by default", () => {
    renderSurface()
    expect(hostProps[0]?.railOrder).toEqual(CONTEXT_ACTIVITY_RAIL_ORDER)
  })

  it("follows the order the user arranged, and drops what they hid", () => {
    // The rail is a stored setting; the kernel ships only the default order, so
    // reading it here is what keeps the Dock's rail the same rail as everywhere
    // else in the app.
    storedRailLayout = { order: ["workspace", "review"], hidden: ["comments"] }
    renderSurface()
    const order = hostProps[0]?.railOrder ?? []
    expect(order.indexOf("workspace")).toBeLessThan(order.indexOf("review"))
    expect(order).not.toContain("comments")
  })

  describe("seeding from the pre-Dock stores", () => {
    function writeLegacy(activePanelId: string, dockSize = 44) {
      window.localStorage.setItem(
        LEGACY_CONTEXT_WORKBENCH_KEY,
        JSON.stringify({ state: { layouts: { "wb::session:sess-1": { activePanelId } } } })
      )
      window.localStorage.setItem(
        LEGACY_ARTIFACT_DOCK_KEY,
        JSON.stringify({ state: { dockSize, dockCollapsed: false } })
      )
    }

    it("carries the panel and the width the user left the workbench at", () => {
      writeLegacy("browser")
      renderSurface()
      expect(layoutOf()?.instances.map((i) => i.panelId)).toEqual(["browser"])
      expect(layoutOf()?.shell.sizePercent).toBe(44)
      expect(layoutOf()?.migratedFrom).toBe("context-workbench-v1")
    })

    it("seeds before the kernel mounts, or the kernel would create an empty one first", () => {
      // `DockHost.onReady` calls `ensureLayout`, and `adoptLayout` is a no-op
      // once a layout exists — so an effect running after mount would arrive
      // too late and silently drop the user's arrangement.
      writeLegacy("browser")
      renderSurface()
      expect(layoutOf()?.instances).toHaveLength(1)
    })

    it("does not resurrect the old arrangement over one the user has since made", () => {
      writeLegacy("browser")
      const { unmount } = renderSurface()
      unmount()
      useDockLayoutStore.getState().setInstances(KEY, [])
      renderSurface()
      expect(layoutOf()?.instances).toEqual([])
    })

    it("leaves the store untouched when there is nothing to carry over", () => {
      renderSurface()
      expect(layoutOf()).toBeUndefined()
    })

    it("drops a carried panel this surface does not offer", () => {
      writeLegacy("proposal-review")
      renderSurface()
      expect(layoutOf()?.instances).toEqual([])
    })

    it("never writes back to the store it read", () => {
      // The legacy stores stay authoritative for every host still on the
      // workbench, and they are what a rollback reads.
      writeLegacy("browser")
      const before = window.localStorage.getItem(LEGACY_CONTEXT_WORKBENCH_KEY)
      const beforeDock = window.localStorage.getItem(LEGACY_ARTIFACT_DOCK_KEY)
      renderSurface()
      expect(window.localStorage.getItem(LEGACY_CONTEXT_WORKBENCH_KEY)).toBe(before)
      expect(window.localStorage.getItem(LEGACY_ARTIFACT_DOCK_KEY)).toBe(beforeDock)
    })

    it("keeps one conversation's seed out of another's layout", () => {
      writeLegacy("browser")
      renderSurface({ contextId: "sess-2", legacyScopeKey: "wb::session:sess-2" })
      expect(layoutOf()).toBeUndefined()
    })
  })
})

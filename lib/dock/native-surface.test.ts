import {
  DOCK_SURFACE_MIN_VISIBLE_PX,
  groupSuppressesAnimation,
  isDockSurfaceRectPaintable,
  resolveNativeSurfaceState,
  sameDockSurfaceRect,
} from "./native-surface"
import { resolveDockPanel } from "./derive-panel-metadata"
import type { ContextPanelDefinition } from "@/types/context-workbench"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { DockPanelDefinition, ResolvedDockPanel } from "@/types/dock/panel"

const rect = { x: 10, y: 20, width: 400, height: 300 }
const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

function instance(overrides: Partial<DockPanelInstance> = {}): DockPanelInstance {
  return {
    instanceId: "i1",
    panelId: "review",
    kind: "panel",
    mode: "pinned",
    dirty: false,
    activated: true,
    ...overrides,
  }
}

function panelMap(...definitions: DockPanelDefinition[]): Map<string, ResolvedDockPanel> {
  return new Map(definitions.map((d) => [d.id, resolveDockPanel(d)]))
}

function definition(id: string, overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id,
    activity: "workspace",
    labelKey: `dock.panels.${id}`,
    appliesTo: () => true,
    renderer,
    ...overrides,
  }
}

describe("isDockSurfaceRectPaintable", () => {
  it("rejects a rect too small to be showing content", () => {
    expect(isDockSurfaceRectPaintable(rect)).toBe(true)
    expect(isDockSurfaceRectPaintable(null)).toBe(false)
    expect(isDockSurfaceRectPaintable({ ...rect, height: DOCK_SURFACE_MIN_VISIBLE_PX - 1 })).toBe(
      false
    )
    expect(isDockSurfaceRectPaintable({ ...rect, width: 0 })).toBe(false)
  })

  it("rejects a rect with non-finite dimensions", () => {
    expect(isDockSurfaceRectPaintable({ ...rect, width: Number.NaN })).toBe(false)
    expect(isDockSurfaceRectPaintable({ ...rect, height: Number.POSITIVE_INFINITY })).toBe(false)
  })
})

describe("resolveNativeSurfaceState", () => {
  const base = { rect, active: true, hostVisible: true, interacting: false }

  it("paints an active surface in a visible host", () => {
    expect(resolveNativeSurfaceState(base)).toEqual({ rect, visible: true })
  })

  it("hides a background tab", () => {
    // dockview keeps a stateful panel mounted but off-screen; the webview would
    // otherwise keep painting over whatever is now in front.
    expect(resolveNativeSurfaceState({ ...base, active: false }).visible).toBe(false)
  })

  it("hides when the dock is collapsed to the rail", () => {
    expect(resolveNativeSurfaceState({ ...base, hostVisible: false }).visible).toBe(false)
  })

  it("hides for the duration of a drag rather than skating behind it", () => {
    // The webview cannot be moved smoothly, so following a gesture frame by
    // frame reads as a native rectangle lagging the pointer.
    expect(resolveNativeSurfaceState({ ...base, interacting: true }).visible).toBe(false)
  })

  it("hides a sliver rather than flickering through a resize", () => {
    expect(resolveNativeSurfaceState({ ...base, rect: { ...rect, height: 2 } }).visible).toBe(false)
  })

  it("reports the rect it was given even when hidden, so a re-show is instant", () => {
    expect(resolveNativeSurfaceState({ ...base, active: false }).rect).toBe(rect)
    expect(resolveNativeSurfaceState({ ...base, rect: null })).toEqual({
      rect: null,
      visible: false,
    })
  })
})

describe("groupSuppressesAnimation", () => {
  it("disqualifies a whole group for one native surface", () => {
    // The animation moves the container, not the individual tab.
    const panels = panelMap(
      definition("browser", { dock: { kind: "native-surface" } }),
      definition("review")
    )
    expect(
      groupSuppressesAnimation(
        [instance(), instance({ instanceId: "i2", panelId: "browser" })],
        panels
      )
    ).toBe(true)
  })

  it("allows a group of ordinary panels to animate", () => {
    expect(groupSuppressesAnimation([instance()], panelMap(definition("review")))).toBe(false)
    expect(groupSuppressesAnimation([], panelMap())).toBe(false)
  })

  it("trusts the instance's own kind when the panel no longer resolves", () => {
    // A plugin can vanish mid-drag; the instance still names a native surface,
    // and animating over one that is still on screen would tear.
    expect(groupSuppressesAnimation([instance({ kind: "native-surface" })], panelMap())).toBe(true)
  })
})

describe("sameDockSurfaceRect", () => {
  it("treats identical rects as unchanged so no update is pushed", () => {
    expect(sameDockSurfaceRect(rect, { ...rect })).toBe(true)
    expect(sameDockSurfaceRect(rect, rect)).toBe(true)
    expect(sameDockSurfaceRect(null, null)).toBe(true)
  })

  it("detects any dimension moving", () => {
    expect(sameDockSurfaceRect(rect, { ...rect, x: 11 })).toBe(false)
    expect(sameDockSurfaceRect(rect, { ...rect, y: 21 })).toBe(false)
    expect(sameDockSurfaceRect(rect, { ...rect, width: 401 })).toBe(false)
    expect(sameDockSurfaceRect(rect, { ...rect, height: 301 })).toBe(false)
    expect(sameDockSurfaceRect(rect, null)).toBe(false)
    expect(sameDockSurfaceRect(null, rect)).toBe(false)
  })
})

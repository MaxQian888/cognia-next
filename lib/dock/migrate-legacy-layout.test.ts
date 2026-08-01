/** @jest-environment jsdom */

import {
  LEGACY_ARTIFACT_DOCK_KEY,
  LEGACY_CONTEXT_WORKBENCH_KEY,
  LEGACY_MIGRATION_SOURCE,
  migrateLegacyDockLayout,
} from "./migrate-legacy-layout"
import { resolveDockPanel } from "./derive-panel-metadata"
import { DEFAULT_DOCK_SHELL_STATE, type DockLayoutKey } from "@/types/dock/layout"
import type { ContextPanelDefinition } from "@/types/context-workbench"
import type { DockPanelDefinition, ResolvedDockPanel } from "@/types/dock/panel"

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

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

function available(...ids: string[]): Map<string, ResolvedDockPanel> {
  return new Map(ids.map((id) => [id, resolveDockPanel(definition(id))]))
}

const KEY: DockLayoutKey = { accountId: "acc", host: "chat", contextId: "s1" }
const SCOPE = "wb::session:s1"

function migrate(panels = available("browser", "workspace")) {
  let n = 0
  return migrateLegacyDockLayout({
    key: KEY,
    legacyScopeKey: SCOPE,
    available: panels,
    createInstanceId: () => `new-${++n}`,
    now: 5000,
  })
}

function writeWorkbench(layouts: Record<string, unknown>) {
  window.localStorage.setItem(
    LEGACY_CONTEXT_WORKBENCH_KEY,
    JSON.stringify({ state: { layouts }, version: 2 })
  )
}

function writeDock(state: Record<string, unknown>) {
  window.localStorage.setItem(LEGACY_ARTIFACT_DOCK_KEY, JSON.stringify({ state, version: 3 }))
}

beforeEach(() => window.localStorage.clear())

describe("migrateLegacyDockLayout", () => {
  it("returns nothing when there is no prior layout to carry over", () => {
    // A fresh install has no legacy state, and the default dock is the honest
    // answer — seeding an envelope would only pin today's defaults into storage.
    expect(migrate()).toBeNull()
  })

  it("carries the panel the user had in front, and only that one", () => {
    // A workbench scope accumulates `activatedPanelIds` over its whole life;
    // restoring all of them would open eight tabs nobody asked for.
    writeWorkbench({
      [SCOPE]: {
        activePanelId: "browser",
        activatedPanelIds: ["browser", "workspace", "comments"],
        userPinned: true,
      },
    })
    const envelope = migrate()
    expect(envelope?.instances).toEqual([
      {
        instanceId: "new-1",
        panelId: "browser",
        kind: "panel",
        mode: "pinned",
        dirty: false,
        activated: false,
      },
    ])
  })

  it("marks the carried panel un-activated so its first-activate work still runs", () => {
    // It is being mounted fresh in a different engine; claiming it was already
    // activated would skip setup a panel does exactly once.
    writeWorkbench({ [SCOPE]: { activePanelId: "browser", activatedPanelIds: ["browser"] } })
    expect(migrate()?.instances[0]?.activated).toBe(false)
    expect(migrate()?.instances[0]?.mode).toBe("pinned")
  })

  it("classifies the carried panel by its kind", () => {
    writeWorkbench({ [SCOPE]: { activePanelId: "browser" } })
    const panels = new Map([
      ["browser", resolveDockPanel(definition("browser", { dock: { kind: "native-surface" } }))],
    ])
    expect(migrate(panels)?.instances[0]?.kind).toBe("native-surface")
  })

  it("drops a panel this build no longer offers rather than opening an empty tab", () => {
    writeWorkbench({ [SCOPE]: { activePanelId: "retired-panel" } })
    const envelope = migrate()
    expect(envelope?.instances).toEqual([])
    expect(envelope?.migratedFrom).toBe(LEGACY_MIGRATION_SOURCE)
  })

  it("carries the width and collapsed state the dock was left at", () => {
    writeWorkbench({ [SCOPE]: { activePanelId: "browser" } })
    writeDock({ dockSize: 52, dockCollapsed: false })
    expect(migrate()?.shell).toEqual({
      ...DEFAULT_DOCK_SHELL_STATE,
      sizePercent: 52,
      collapsed: false,
    })
  })

  it("clamps a stored width the dock could not actually render", () => {
    // localStorage is user-editable, and an old build's bounds are not this
    // build's — a 95% dock would leave the conversation unusable.
    writeDock({ dockSize: 95, dockCollapsed: false })
    expect(migrate()?.shell.sizePercent).toBe(70)
  })

  it("seeds from the dock chrome alone when the workbench scope is new", () => {
    // Opening a brand-new conversation still deserves the width the user drags
    // every other conversation to.
    writeDock({ dockSize: 40, dockCollapsed: false })
    const envelope = migrate()
    expect(envelope?.instances).toEqual([])
    expect(envelope?.shell.sizePercent).toBe(40)
  })

  it("leaves rail-only to the live setting instead of guessing", () => {
    // Whether a collapsed dock shrinks to the rail or to nothing is a Dexie
    // setting; a stale localStorage value must not override it.
    writeDock({ dockSize: 40, dockCollapsed: true, railOnly: false })
    expect(migrate()?.shell.railOnly).toBe(DEFAULT_DOCK_SHELL_STATE.railOnly)
  })

  it("stamps where it came from, so a later reader can tell seeded from earned", () => {
    writeWorkbench({ [SCOPE]: { activePanelId: "browser" } })
    const envelope = migrate()
    expect(envelope?.migratedFrom).toBe(LEGACY_MIGRATION_SOURCE)
    expect(envelope?.key).toEqual(KEY)
    expect(envelope?.revision).toBe(1)
    expect(envelope?.grid).toBeNull()
    expect(envelope?.updatedAt).toBe(5000)
  })

  it("reads only this host's scope, not a neighbour's", () => {
    writeWorkbench({ "wb::session:other": { activePanelId: "browser" } })
    expect(migrate()).toBeNull()
  })

  it("survives every shape localStorage can actually hold", () => {
    for (const raw of ["not-json", "null", '"a string"', "7", "[]", "{}", '{"state":7}']) {
      window.localStorage.setItem(LEGACY_CONTEXT_WORKBENCH_KEY, raw)
      window.localStorage.setItem(LEGACY_ARTIFACT_DOCK_KEY, raw)
      expect(migrate()).toBeNull()
    }
  })

  it("ignores a layouts map, a layout and fields of the wrong type", () => {
    writeWorkbench({ [SCOPE]: 7 })
    expect(migrate()).toBeNull()

    window.localStorage.setItem(
      LEGACY_CONTEXT_WORKBENCH_KEY,
      JSON.stringify({ state: { layouts: 7 } })
    )
    expect(migrate()).toBeNull()

    writeWorkbench({ [SCOPE]: { activePanelId: 7, activatedPanelIds: "browser" } })
    expect(migrate()?.instances).toEqual([])

    writeDock({ dockSize: "wide", dockCollapsed: "yes" })
    expect(migrate()?.shell).toEqual(DEFAULT_DOCK_SHELL_STATE)
  })

  it("keeps only the string entries of a hand-edited activated list", () => {
    writeWorkbench({
      [SCOPE]: { activePanelId: "browser", activatedPanelIds: ["browser", 7, null] },
    })
    expect(migrate()?.instances).toHaveLength(1)
  })
})

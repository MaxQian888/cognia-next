import {
  getDockPanelsRevision,
  indexDockPanels,
  resolveDockPanels,
  subscribeDockPanels,
} from "./panel-registry"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import type { DockPanelDefinition } from "@/types/dock/panel"

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

const resource: ContextResource = {
  kind: "session",
  sessionId: "s1",
  capabilities: ["review", "ai"],
}

function definition(id: string, overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id,
    activity: "inspect",
    labelKey: `dock.panels.${id}`,
    appliesTo: () => true,
    renderer,
    ...overrides,
  }
}

function fakeRegistry(...definitions: DockPanelDefinition[]) {
  return { resolve: () => definitions as ContextPanelDefinition[] }
}

describe("resolveDockPanels", () => {
  it("merges plugin panels with the host's own and derives metadata", () => {
    const panels = resolveDockPanels({
      resource,
      native: [definition("preview")],
      registry: fakeRegistry(definition("acme.notes", { pluginId: "acme" })),
    })
    expect(panels.map((p) => p.definition.id).sort()).toEqual(["acme.notes", "preview"])
    expect(panels.find((p) => p.definition.id === "acme.notes")?.meta.kind).toBe("plugin-surface")
    expect(panels.find((p) => p.definition.id === "preview")?.meta.kind).toBe("panel")
  })

  it("lets a native panel win an id collision so a plugin cannot shadow it", () => {
    const native = definition("review", { labelKey: "native" })
    const panels = resolveDockPanels({
      resource,
      native: [native],
      registry: fakeRegistry(definition("review", { pluginId: "acme", labelKey: "plugin" })),
    })
    expect(panels).toHaveLength(1)
    expect(panels[0]?.definition.labelKey).toBe("native")
  })

  it("drops a native panel that does not apply to the resource", () => {
    const panels = resolveDockPanels({
      resource,
      native: [definition("preview", { appliesTo: () => false }), definition("review")],
      registry: fakeRegistry(),
    })
    expect(panels.map((p) => p.definition.id)).toEqual(["review"])
  })

  it("trusts the context registry's own applicability filtering for plugin panels", () => {
    // `contextPanelRegistry.resolve` already applied `appliesTo`, capabilities
    // and the permission thunk; re-running `appliesTo` here would double-gate a
    // panel whose predicate is not idempotent.
    const panels = resolveDockPanels({
      resource,
      native: [],
      registry: fakeRegistry(
        definition("acme.notes", { appliesTo: () => false, pluginId: "acme" })
      ),
    })
    expect(panels.map((p) => p.definition.id)).toEqual(["acme.notes"])
  })

  it("orders by rail group, then panel order, then id", () => {
    const panels = resolveDockPanels({
      resource,
      native: [
        definition("z-inspect", { activity: "inspect" }),
        definition("a-inspect", { activity: "inspect" }),
        definition("review-late", { activity: "review", order: 50 }),
        definition("review-early", { activity: "review", order: 10 }),
        definition("preview", { activity: "preview-run" }),
      ],
      registry: fakeRegistry(),
    })
    expect(panels.map((p) => p.definition.id)).toEqual([
      "preview",
      "review-early",
      "review-late",
      "a-inspect",
      "z-inspect",
    ])
  })

  it("defaults to the shared context registry when none is injected", () => {
    const dispose = contextPanelRegistry.register(
      definition("dock.registry.spec", { pluginId: "spec" })
    )
    try {
      const ids = resolveDockPanels({ resource, native: [] }).map((p) => p.definition.id)
      expect(ids).toContain("dock.registry.spec")
    } finally {
      dispose()
    }
  })
})

describe("indexDockPanels", () => {
  it("keys resolved panels by id", () => {
    const panels = resolveDockPanels({
      resource,
      native: [definition("a"), definition("b")],
      registry: fakeRegistry(),
    })
    const index = indexDockPanels(panels)
    expect([...index.keys()].sort()).toEqual(["a", "b"])
    expect(index.get("a")?.definition.id).toBe("a")
  })
})

describe("registry invalidation", () => {
  it("bumps the revision and notifies when a panel comes and goes", () => {
    // A plugin unload has to reach the dock, or it renders a panel whose
    // renderer no longer exists.
    const seen: number[] = []
    const unsubscribe = subscribeDockPanels(() => seen.push(getDockPanelsRevision()))
    const before = getDockPanelsRevision()
    const dispose = contextPanelRegistry.register(definition("dock.registry.notify"))
    dispose()
    unsubscribe()

    expect(seen).toHaveLength(2)
    expect(getDockPanelsRevision()).toBeGreaterThan(before)
  })
})

import { createContextPanelRegistry } from "./panel-registry"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"

const resource: ContextResource = {
  kind: "canvas-document",
  documentId: "doc-1",
  revision: "1",
  capabilities: ["comments", "preview"],
}

function panel(
  id: string,
  overrides: Partial<ContextPanelDefinition> = {}
): ContextPanelDefinition {
  return {
    id,
    activity: "inspect",
    labelKey: `panels.${id}`,
    appliesTo: () => true,
    renderer: () => null,
    ...overrides,
  }
}

describe("context panel registry", () => {
  it("sorts native and plugin panels and supports additional activities", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("late", { order: 30 }))
    registry.register(panel("templates", { activity: "templates", order: 20 }))
    registry.register(panel("early", { order: 10 }))

    expect(registry.resolve(resource)).toEqual([
      expect.objectContaining({ id: "early" }),
      expect.objectContaining({ id: "templates", activity: "templates" }),
      expect.objectContaining({ id: "late" }),
    ])
  })

  it("adds a pushed badge to the definition's own count and bumps the revision", () => {
    const registry = createContextPanelRegistry()
    const dispose = registry.register(panel("inbox", { getBadge: () => 2 }))
    const before = registry.getRevision()

    expect(registry.setBadge("inbox", 3)).toBe(true)
    expect(registry.get("inbox")?.getBadge?.(resource)).toBe(5)
    expect(registry.getRevision()).toBeGreaterThan(before)

    // A repeated write is a no-op, so a polling contributor can't spin the
    // workbench's subscribers on every tick.
    const steady = registry.getRevision()
    expect(registry.setBadge("inbox", 3)).toBe(true)
    expect(registry.getRevision()).toBe(steady)

    expect(registry.setBadge("inbox", -4)).toBe(true)
    expect(registry.get("inbox")?.getBadge?.(resource)).toBe(2)
    expect(registry.setBadge("missing", 1)).toBe(false)

    // Re-registering under the same id must not inherit the old count.
    dispose()
    registry.register(panel("inbox"))
    expect(registry.get("inbox")?.getBadge?.(resource)).toBe(0)
  })

  it("drops pushed badges when a plugin is unregistered wholesale", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("p:one", { pluginId: "p" }))
    registry.setBadge("p:one", 7)

    registry.unregisterPlugin("p")
    registry.register(panel("p:one", { pluginId: "p" }))
    expect(registry.get("p:one")?.getBadge?.(resource)).toBe(0)
  })

  it("filters by applicability, capabilities, and the injected permission gate", () => {
    const registry = createContextPanelRegistry()
    const granted = new Set(["extension:ui"])
    registry.register(panel("wrong-resource", { appliesTo: () => false }))
    registry.register(panel("missing-capability", { requiredCapabilities: ["run"] }))
    registry.register(
      panel("allowed", {
        requiredCapabilities: ["comments"],
        // Declared for diagnostics only — resolve never reads it.
        requiredPermissions: ["extension:ui", "canvas:read"],
        hasRequiredPermissions: () =>
          ["extension:ui", "canvas:read"].every((permission) => granted.has(permission)),
      })
    )

    expect(registry.resolve(resource)).toEqual([])

    // The gate is a live closure, so a later grant takes effect without
    // re-registering — this is what `permission-api`'s `refresh()` relies on.
    granted.add("canvas:read")
    expect(registry.resolve(resource)).toEqual([expect.objectContaining({ id: "allowed" })])
  })

  it("never gates on the declared requiredPermissions alone", () => {
    // The old flat `grantedPermissions` set could not express per-plugin
    // grants, so this field silently hid any panel that declared it. It is now
    // inert data; only `hasRequiredPermissions` decides.
    const registry = createContextPanelRegistry()
    registry.register(panel("declared-only", { requiredPermissions: ["never:granted"] }))

    expect(registry.resolve(resource)).toEqual([expect.objectContaining({ id: "declared-only" })])
  })

  it("rejects duplicate panel ids and unregisters all panels from one plugin", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("one", { pluginId: "plugin-a" }))
    registry.register(panel("two", { pluginId: "plugin-a" }))

    expect(() => registry.register(panel("one"))).toThrow(/one/)
    registry.unregisterPlugin("plugin-a")
    expect(registry.resolve(resource)).toEqual([])
  })

  it("notifies subscribers only for effective registry changes", () => {
    const registry = createContextPanelRegistry()
    const listener = jest.fn()
    const unsubscribe = registry.subscribe(listener)
    const unregister = registry.register(panel("registered"))
    expect(registry.getRevision()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    registry.unregister("missing")
    registry.unregisterPlugin("missing-plugin")
    expect(listener).toHaveBeenCalledTimes(1)

    unregister()
    expect(registry.getRevision()).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registry.register(panel("after-unsubscribe"))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("applies runtime permission gates and deterministic id ordering", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("z-panel", { order: 10 }))
    registry.register(panel("a-panel", { order: 10 }))
    registry.register(
      panel("runtime-denied", {
        hasRequiredPermissions: () => false,
      })
    )

    expect(registry.resolve(resource).map((definition) => definition.id)).toEqual([
      "a-panel",
      "z-panel",
    ])
  })

  it("lists all distinct activities from registered panels", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("p1", { activity: "inspect" }))
    registry.register(panel("p2", { activity: "ai" }))
    registry.register(panel("p3", { activity: "inspect" }))
    registry.register(panel("p4", { activity: "custom-activity" }))

    const activities = registry.listActivities()
    expect(activities.sort()).toEqual(["ai", "custom-activity", "inspect"])
  })

  it("listActivities reflects unregistration", () => {
    const registry = createContextPanelRegistry()
    registry.register(panel("p1", { activity: "inspect", pluginId: "my-plugin" }))
    registry.register(panel("p2", { activity: "plugin-only", pluginId: "my-plugin" }))

    expect(registry.listActivities()).toContain("plugin-only")

    registry.unregisterPlugin("my-plugin")

    expect(registry.listActivities()).not.toContain("plugin-only")
  })
})

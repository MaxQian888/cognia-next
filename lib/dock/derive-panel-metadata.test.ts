import { deriveDockPanelMetadata, resolveDockPanel } from "./derive-panel-metadata"
import type { ContextPanelDefinition } from "@/types/context-workbench"
import type { DockPanelDefinition } from "@/types/dock/panel"

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

function panel(overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id: "preview",
    activity: "preview-run",
    labelKey: "dock.panels.preview",
    appliesTo: () => true,
    renderer,
    ...overrides,
  }
}

describe("deriveDockPanelMetadata", () => {
  it("passes a plain Context Workbench definition through with today's defaults", () => {
    // The migration promise: a definition that knows nothing about the dock has
    // to keep behaving exactly as the Context Workbench made it behave.
    expect(deriveDockPanelMetadata(panel())).toEqual({
      kind: "panel",
      singletonPolicy: "singleton-per-context",
      retention: "stateful",
      allowedLocations: ["grid", "floating", "popout"],
      minSize: undefined,
      permissions: [],
      capabilities: [],
    })
  })

  it("defaults retention to stateful, matching the workbench's unmount rule", () => {
    // The workbench only unmounts on an explicit "ephemeral"; absent means keep
    // it mounted. Flipping this default would silently drop panel state.
    expect(deriveDockPanelMetadata(panel()).retention).toBe("stateful")
    expect(deriveDockPanelMetadata(panel({ retention: "ephemeral" })).retention).toBe("ephemeral")
  })

  it("classifies a plugin panel by its pluginId", () => {
    const meta = deriveDockPanelMetadata(panel({ pluginId: "acme.tools" }))
    expect(meta.kind).toBe("plugin-surface")
    expect(meta.singletonPolicy).toBe("singleton-per-context")
  })

  it("pins a native surface to the grid as a global singleton", () => {
    const meta = deriveDockPanelMetadata(panel({ dock: { kind: "native-surface" } }))
    expect(meta.kind).toBe("native-surface")
    expect(meta.singletonPolicy).toBe("singleton-global")
    expect(meta.allowedLocations).toEqual(["grid"])
  })

  it("treats editors as multi-instance so two files can be open at once", () => {
    const meta = deriveDockPanelMetadata(panel({ dock: { kind: "editor" } }))
    expect(meta.singletonPolicy).toBe("multi-instance")
    expect(meta.allowedLocations).toEqual(["grid", "floating", "popout"])
  })

  it("lets an explicit dock bag override every derived field", () => {
    const meta = deriveDockPanelMetadata(
      panel({
        pluginId: "acme.tools",
        retention: "ephemeral",
        requiredPermissions: ["ignored"],
        requiredCapabilities: ["review"],
        dock: {
          kind: "editor",
          singletonPolicy: "singleton-global",
          retention: "stateful",
          allowedLocations: ["grid", "floating"],
          minSize: { width: 320 },
          permissions: ["extension:ui"],
          capabilities: ["ai"],
        },
      })
    )
    expect(meta).toEqual({
      kind: "editor",
      singletonPolicy: "singleton-global",
      retention: "stateful",
      allowedLocations: ["grid", "floating"],
      minSize: { width: 320 },
      permissions: ["extension:ui"],
      capabilities: ["ai"],
    })
  })

  it("carries the definition's declared permissions and capabilities through", () => {
    const meta = deriveDockPanelMetadata(
      panel({ requiredPermissions: ["project:read"], requiredCapabilities: ["inspect"] })
    )
    expect(meta.permissions).toEqual(["project:read"])
    expect(meta.capabilities).toEqual(["inspect"])
  })

  it("keeps a session-scoped panel as one instance per context", () => {
    expect(deriveDockPanelMetadata(panel({ scope: "session" })).singletonPolicy).toBe(
      "singleton-per-context"
    )
  })
})

describe("resolveDockPanel", () => {
  it("pairs the definition with its metadata without copying it", () => {
    const definition = panel()
    const resolved = resolveDockPanel(definition)
    expect(resolved.definition).toBe(definition)
    expect(resolved.meta.kind).toBe("panel")
  })
})

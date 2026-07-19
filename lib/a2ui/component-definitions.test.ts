import { getStandardComponentTypes } from "./catalog"
import {
  collectComponentSubtreeIds,
  getComponentChildReferences,
  hasComponentReferenceCycle,
} from "./component-tree"
import { createA2UIComponentBundle, createAvailableComponentId } from "./component-definitions"

describe("A2UI component definitions", () => {
  it.each(getStandardComponentTypes())("creates a connected renderer-valid %s bundle", (type) => {
    const bundle = createA2UIComponentBundle(type, "new-component")
    const components = Object.fromEntries(
      bundle.components.map((component) => [component.id, component])
    )

    expect(bundle.rootId).toBe("new-component")
    expect(components[bundle.rootId]?.component).toBe(type)
    expect(Object.keys(components)).toHaveLength(bundle.components.length)
    expect(collectComponentSubtreeIds(components, bundle.rootId)).toEqual(
      new Set(Object.keys(components))
    )
    expect(hasComponentReferenceCycle(components, bundle.rootId)).toBe(false)
    for (const component of bundle.components) {
      for (const reference of getComponentChildReferences(component)) {
        expect(components[reference.id]).toBeDefined()
      }
    }
  })

  it.each(["Popover", "HoverCard", "Drawer", "Sheet", "DropdownMenu", "ContextMenu"])(
    "includes the required trigger dependency for %s",
    (type) => {
      const bundle = createA2UIComponentBundle(type, "overlay")
      expect(bundle.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "overlay", component: type, trigger: "overlay-trigger" }),
          expect.objectContaining({ id: "overlay-trigger", component: "Button" }),
        ])
      )
    }
  )

  it("preserves unknown custom catalog types without inventing unsupported properties", () => {
    expect(createA2UIComponentBundle("PluginWidget", "plugin-widget")).toEqual({
      rootId: "plugin-widget",
      components: [{ id: "plugin-widget", component: "PluginWidget" }],
    })
  })

  it("creates stable kebab-case ids without colliding with the surface", () => {
    expect(
      createAvailableComponentId("Rich Output", new Set(["rich-output", "rich-output-2"]))
    ).toBe("rich-output-3")
    expect(createAvailableComponentId("  ", new Set())).toBe("component")
  })
})

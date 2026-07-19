import type { A2UIComponent } from "@/types/a2ui/schema"
import {
  getA2UIEnumPropertyDefinition,
  getA2UIEnumPropertyDefinitions,
  getEditableComponentProperties,
  getEditableStructuralMetadata,
  replaceEditableComponentProperties,
  replaceEditableStructuralMetadata,
} from "./component-properties"
import { getStandardComponentTypes } from "./catalog"
import { createA2UIComponentBundle } from "./component-definitions"

const component = (value: Record<string, unknown>) => value as unknown as A2UIComponent

describe("A2UI editable component properties", () => {
  it("exposes schema-constrained enum editors for core and extended catalog components", () => {
    expect(getA2UIEnumPropertyDefinitions("Button")).toEqual([
      {
        property: "variant",
        options: ["default", "primary", "secondary", "destructive", "outline", "ghost", "link"],
      },
      { property: "iconPosition", options: ["left", "right"] },
    ])
    expect(getA2UIEnumPropertyDefinition("Animation", "direction")?.options).toEqual([
      "up",
      "down",
      "left",
      "right",
    ])
    expect(getA2UIEnumPropertyDefinition("Toast", "variant")?.options).toEqual([
      "default",
      "success",
      "error",
      "warning",
      "info",
      "loading",
    ])
    expect(getA2UIEnumPropertyDefinitions("CustomWidget")).toEqual([])
  })

  it("keeps every enum editor option unique and non-empty", () => {
    for (const type of getStandardComponentTypes()) {
      for (const definition of getA2UIEnumPropertyDefinitions(type)) {
        expect(definition.property).not.toBe("")
        expect(definition.options.length).toBeGreaterThan(0)
        expect(new Set(definition.options).size).toBe(definition.options.length)
      }
    }
  })

  it("rejects new invalid enum values while preserving unchanged legacy values", () => {
    const source = component({
      id: "button",
      component: "Button",
      text: "Before",
      action: "submit",
    })
    expect(
      replaceEditableComponentProperties(source, {
        text: "After",
        action: "submit",
        variant: "rainbow",
      })
    ).toBeNull()

    const legacy = component({ ...source, variant: "legacy-plugin-variant" })
    expect(
      replaceEditableComponentProperties(legacy, {
        text: "After",
        action: "submit",
        variant: "legacy-plugin-variant",
      })
    ).toMatchObject({ text: "After", variant: "legacy-plugin-variant" })
  })

  it("separates property data from tree-owned structural references", () => {
    const value = component({
      id: "card",
      component: "Card",
      title: "Title",
      visible: { path: "/visible" },
      children: ["body"],
      footer: ["action"],
    })

    expect(getEditableComponentProperties(value)).toEqual({
      title: "Title",
      visible: { path: "/visible" },
    })
  })

  it("keeps similarly named data properties editable on non-structural component types", () => {
    expect(
      getEditableComponentProperties(
        component({
          id: "comparison",
          component: "ComparisonCards",
          items: [{ id: "one", title: "One" }],
        })
      )
    ).toEqual({ items: [{ id: "one", title: "One" }] })
  })

  it("replaces editable properties while preserving identity and structural slots", () => {
    const source = component({
      id: "dialog",
      component: "Dialog",
      title: "Old",
      description: "Remove me",
      open: false,
      children: ["body"],
      actions: ["save"],
    })

    expect(
      replaceEditableComponentProperties(source, {
        title: "New",
        open: { path: "/dialog/open" },
      })
    ).toEqual({
      id: "dialog",
      component: "Dialog",
      title: "New",
      open: { path: "/dialog/open" },
      children: ["body"],
      actions: ["save"],
    })
  })

  it("rejects identity, structural, and prototype mutation attempts", () => {
    const source = component({ id: "root", component: "Column", children: [] })

    expect(replaceEditableComponentProperties(source, { id: "other" })).toBeNull()
    expect(replaceEditableComponentProperties(source, { component: "Text" })).toBeNull()
    expect(replaceEditableComponentProperties(source, { children: ["missing"] })).toBeNull()
    expect(
      replaceEditableComponentProperties(
        source,
        JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
      )
    ).toBeNull()
  })

  it("preserves non-protocol runtime values instead of crashing or deleting them", () => {
    const render = () => "cell"
    const source = component({
      id: "table",
      component: "Table",
      columns: [{ key: "name", header: "Name", render }],
      data: [],
      runtimeExtension: render,
    })

    expect(getEditableComponentProperties(source)).toEqual({ data: [] })
    expect(replaceEditableComponentProperties(source, { data: [] })).toMatchObject({
      columns: [{ key: "name", header: "Name", render }],
      runtimeExtension: render,
    })
    expect(replaceEditableComponentProperties(source, { runtimeExtension: render })).toBeNull()
  })

  it("edits tab metadata and ordering while preserving every child slot", () => {
    const source = component({
      id: "tabs",
      component: "Tabs",
      tabs: [
        { id: "first", label: "First", children: ["first-content"] },
        { id: "empty", label: "Empty", children: [] },
      ],
    })

    expect(getEditableStructuralMetadata(source)).toEqual({
      tabs: [
        { id: "first", label: "First" },
        { id: "empty", label: "Empty" },
      ],
    })
    expect(
      replaceEditableStructuralMetadata(source, {
        tabs: [
          { id: "new", label: "New" },
          { id: "first", label: "Renamed", disabled: true },
        ],
      })
    ).toMatchObject({
      tabs: [
        { id: "new", label: "New", children: [] },
        { id: "first", label: "Renamed", disabled: true, children: ["first-content"] },
      ],
    })
  })

  it("rejects destructive or malformed structural metadata edits", () => {
    const source = component({
      id: "accordion",
      component: "Accordion",
      items: [{ id: "kept", title: "Kept", children: ["content"] }],
    })

    expect(replaceEditableStructuralMetadata(source, { items: [] })).toBeNull()
    expect(
      replaceEditableStructuralMetadata(source, {
        items: [{ id: "kept", title: "Kept", children: [] }],
      })
    ).toBeNull()
    expect(
      replaceEditableStructuralMetadata(source, {
        items: [
          { id: "kept", title: "A" },
          { id: "kept", title: "B" },
        ],
      })
    ).toBeNull()
  })

  it("preserves guide content and list template component references", () => {
    const guide = component({
      id: "guide",
      component: "InteractiveGuide",
      steps: [{ id: "step", title: "Before", content: ["content"] }],
    })
    const list = component({
      id: "list",
      component: "List",
      template: { itemId: "item", dataPath: "/old" },
    })

    expect(
      replaceEditableStructuralMetadata(guide, {
        steps: [{ id: "step", title: "After", isOptional: true }],
      })
    ).toMatchObject({
      steps: [{ id: "step", title: "After", isOptional: true, content: ["content"] }],
    })
    expect(getEditableStructuralMetadata(list)).toEqual({ template: { dataPath: "/old" } })
    expect(
      replaceEditableStructuralMetadata(list, { template: { dataPath: "/new" } })
    ).toMatchObject({ template: { itemId: "item", dataPath: "/new" } })
  })

  it.each(getStandardComponentTypes())(
    "round-trips every editable %s property without losing its structural bundle",
    (type) => {
      const bundle = createA2UIComponentBundle(type, "component")
      const root = bundle.components.find((entry) => entry.id === bundle.rootId)!
      expect(
        replaceEditableComponentProperties(root, getEditableComponentProperties(root))
      ).toEqual(root)
    }
  )
})

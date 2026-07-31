import {
  canDuplicateComponentSubtree,
  collectComponentSubtreeIds,
  getComponentChildReferences,
  getComponentCollectionSlots,
  rewriteComponentChildReferences,
  rewriteComponentCollectionSlot,
} from "./component-tree"
import type { A2UIComponent } from "@/types/a2ui/schema"

const component = (value: Record<string, unknown>) => value as unknown as A2UIComponent

describe("A2UI component-tree references", () => {
  it("discovers every renderer-owned child reference shape", () => {
    const value = component({
      id: "container",
      component: "CustomContainer",
      children: ["child"],
      footer: ["footer"],
      actions: ["action"],
      tabs: [{ id: "tab", label: "Tab", children: ["tab-child"] }],
      items: [{ id: "item", title: "Item", children: ["item-child"] }],
      steps: [{ id: "step", content: ["step-child"] }],
      trigger: "trigger",
      template: { itemId: "template", dataPath: "/items" },
    })

    expect(getComponentChildReferences(value)).toEqual([
      { id: "child", kind: "collection" },
      { id: "footer", kind: "collection" },
      { id: "action", kind: "collection" },
      { id: "tab-child", kind: "collection" },
      { id: "item-child", kind: "collection" },
      { id: "step-child", kind: "collection" },
      { id: "trigger", kind: "required" },
      { id: "template", kind: "required" },
    ])
  })

  it("rewrites collection and required references without mutating the source", () => {
    const source = component({
      id: "container",
      component: "Card",
      children: ["keep", "replace"],
      footer: ["replace"],
      trigger: "replace",
      template: { itemId: "replace", dataPath: "/items" },
    })

    const rewritten = rewriteComponentChildReferences(source, (reference) =>
      reference.id === "replace" ? ["copy"] : [reference.id]
    ) as unknown as Record<string, unknown>

    expect(rewritten).toMatchObject({
      children: ["keep", "copy"],
      footer: ["copy"],
      trigger: "copy",
      template: { itemId: "copy", dataPath: "/items" },
    })
    expect(source).toMatchObject({
      children: ["keep", "replace"],
      footer: ["replace"],
      trigger: "replace",
      template: { itemId: "replace", dataPath: "/items" },
    })
  })

  it("collects a cycle-safe subtree across collection and required references", () => {
    const components = {
      root: component({ id: "root", component: "Column", children: ["overlay"] }),
      overlay: component({
        id: "overlay",
        component: "Popover",
        trigger: "trigger",
        children: ["content"],
      }),
      trigger: component({ id: "trigger", component: "Button", children: ["overlay"] }),
      content: component({ id: "content", component: "Text" }),
      orphan: component({ id: "orphan", component: "Text" }),
    }

    expect([...collectComponentSubtreeIds(components, "overlay")]).toEqual([
      "overlay",
      "content",
      "trigger",
    ])
  })

  it("only allows duplication when the subtree has an external collection parent", () => {
    const components = {
      root: component({ id: "root", component: "Column", children: ["group", "overlay"] }),
      group: component({ id: "group", component: "Column", children: ["child"] }),
      child: component({ id: "child", component: "Text" }),
      overlay: component({ id: "overlay", component: "Popover", trigger: "trigger", children: [] }),
      trigger: component({ id: "trigger", component: "Button" }),
    }

    expect(canDuplicateComponentSubtree(components, "root", "group")).toBe(true)
    expect(canDuplicateComponentSubtree(components, "root", "root")).toBe(false)
    expect(canDuplicateComponentSubtree(components, "root", "trigger")).toBe(false)
  })

  it("exposes opaque collection slots and rewrites exactly the selected slot", () => {
    const source = component({
      id: "container",
      component: "CustomContainer",
      children: ["child"],
      footer: ["footer"],
      actions: ["action"],
      tabs: [{ id: "tab-a", label: "A", children: ["tab-child"] }],
      items: [{ id: "item-a", title: "A", children: ["item-child"] }],
      steps: [{ id: "step-a", content: ["step-child"] }],
    })

    expect(getComponentCollectionSlots(source)).toEqual([
      { id: "/children", childIds: ["child"] },
      { id: "/footer", childIds: ["footer"] },
      { id: "/actions", childIds: ["action"] },
      { id: "/tabs/0/children", childIds: ["tab-child"] },
      { id: "/items/0/children", childIds: ["item-child"] },
      { id: "/steps/0/content", childIds: ["step-child"] },
    ])

    const rewritten = rewriteComponentCollectionSlot(source, "/tabs/0/children", (ids) => [
      ids[0],
      "inserted",
    ]) as unknown as Record<string, unknown>
    expect(rewritten.tabs).toEqual([
      { id: "tab-a", label: "A", children: ["tab-child", "inserted"] },
    ])
    expect(rewritten.children).toEqual(["child"])
    expect(source).toMatchObject({ tabs: [{ children: ["tab-child"] }] })
    expect(rewriteComponentCollectionSlot(source, "/missing", () => [])).toBeNull()
  })

  it("exposes renderer-supported empty slots before their first child exists", () => {
    const emptyCard = component({ id: "card", component: "Card" })
    const emptyDialog = component({ id: "dialog", component: "Dialog", open: true })
    const leaf = component({ id: "text", component: "Text", text: "Leaf" })

    expect(getComponentCollectionSlots(emptyCard)).toEqual([
      { id: "/children", childIds: [] },
      { id: "/footer", childIds: [] },
    ])
    expect(getComponentCollectionSlots(emptyDialog)).toEqual([
      { id: "/children", childIds: [] },
      { id: "/actions", childIds: [] },
    ])
    expect(getComponentCollectionSlots(leaf)).toEqual([])

    const withFooter = rewriteComponentCollectionSlot(emptyCard, "/footer", () => ["button"])
    expect(withFooter).toMatchObject({ footer: ["button"] })
    expect(emptyCard).not.toHaveProperty("footer")
  })
})

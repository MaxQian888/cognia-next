import {
  pluginActionIsEligible,
  resolveSelectionActionSlots,
  type SelectionHostActionDescriptor,
} from "./action-layout"

const plugin = (id: string): SelectionHostActionDescriptor => ({
  id,
  title: id,
  source: "plugin",
  pluginId: id.split(":")[0],
  input: "metadata",
  output: "status",
})

it("preserves the current six built-ins when no layout or plugin pin changes it", () => {
  expect(
    resolveSelectionActionSlots({
      builtInIds: ["copy", "explain", "translate", "ask", "remember", "speak"],
      pluginActions: [plugin("plug:a")],
      layout: { ordered: [], hidden: [], pinned: [] },
    })
  ).toEqual({
    primaryIds: ["copy", "explain", "translate", "ask", "remember", "speak"],
    overflowIds: ["plug:a"],
  })
})

it("lets pinned plugin actions replace lower-priority slots without evicting copy", () => {
  expect(
    resolveSelectionActionSlots({
      builtInIds: ["copy", "explain", "translate", "ask", "remember", "speak"],
      pluginActions: [plugin("plug:a"), plugin("plug:b")],
      layout: {
        ordered: ["copy", "plug:b", "explain", "plug:a"],
        hidden: [],
        pinned: ["plug:a", "plug:b"],
      },
    })
  ).toEqual({
    primaryIds: ["copy", "plug:b", "explain", "plug:a", "translate", "ask"],
    overflowIds: ["remember", "speak"],
  })
})

it("keeps copy first even when a saved layout hides or demotes it", () => {
  expect(
    resolveSelectionActionSlots({
      builtInIds: ["copy", "explain", "translate"],
      pluginActions: [plugin("plug:a")],
      layout: {
        ordered: ["plug:a", "translate", "explain", "copy"],
        hidden: ["copy"],
        pinned: [],
      },
    })
  ).toEqual({
    primaryIds: ["copy", "plug:a", "translate", "explain"],
    overflowIds: [],
  })
})

it("hides disabled actions while retaining unknown layout ids for later", () => {
  const layout = {
    ordered: ["missing-plugin:retained", "plug:a"],
    hidden: ["explain"],
    pinned: ["missing-plugin:retained"],
  }
  expect(
    resolveSelectionActionSlots({
      builtInIds: ["copy", "explain", "translate"],
      pluginActions: [plugin("plug:a")],
      layout,
    })
  ).toEqual({ primaryIds: ["copy", "plug:a", "translate"], overflowIds: [] })
  expect(layout.pinned).toContain("missing-plugin:retained")
})

it("filters plugin eligibility by origin, classification, and character limit", () => {
  const action: SelectionHostActionDescriptor = {
    ...plugin("plug:code"),
    origins: ["accessibility"],
    contentTypes: ["code"],
    maxChars: 20,
  }
  expect(
    pluginActionIsEligible(action, {
      origin: "accessibility",
      contentTypes: ["code"],
      chars: 20,
    })
  ).toBe(true)
  expect(pluginActionIsEligible(action, { origin: "ocr", contentTypes: ["code"], chars: 20 })).toBe(
    false
  )
  expect(
    pluginActionIsEligible(action, {
      origin: "accessibility",
      contentTypes: ["term"],
      chars: 20,
    })
  ).toBe(false)
  expect(
    pluginActionIsEligible(action, {
      origin: "accessibility",
      contentTypes: ["code"],
      chars: 21,
    })
  ).toBe(false)
})

it("moves a pinned overflow action into the capsule without explicit ordering", () => {
  expect(
    resolveSelectionActionSlots({
      builtInIds: ["copy", "explain", "translate", "ask", "remember", "speak"],
      pluginActions: [plugin("plug:pinned")],
      layout: { ordered: [], hidden: [], pinned: ["plug:pinned"] },
    })
  ).toEqual({
    primaryIds: ["copy", "plug:pinned", "explain", "translate", "ask", "remember"],
    overflowIds: ["speak"],
  })
})

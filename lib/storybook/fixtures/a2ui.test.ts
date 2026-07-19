import {
  makeA2UIProps,
  makeAppInstance,
  makeAppTemplate,
  makeHistoryEntry,
  makePaper,
  makeSimplifiedSpec,
  makeSurfaceState,
} from "./a2ui"

describe("A2UI Storybook fixtures", () => {
  it("builds a connected surface and simplified tool payload", () => {
    const surface = makeSurfaceState({ title: "Override" })
    expect(surface).toMatchObject({ title: "Override", rootId: "root", ready: true })
    expect(surface.components.root).toMatchObject({ children: ["heading", "body", "cta"] })

    const spec = makeSimplifiedSpec("surface-x")
    expect(spec.surface.id).toBe("surface-x")
    expect(spec.components[0]).toMatchObject({ id: "root", children: ["text"] })
  })

  it("applies caller overrides to every fixture builder", () => {
    expect(makeHistoryEntry({ id: "history-x" }).id).toBe("history-x")
    expect(makeAppInstance({ name: "App X" }).name).toBe("App X")
    expect(makeAppTemplate({ category: "social" }).category).toBe("social")
    expect(makePaper({ title: "Paper X" }).title).toBe("Paper X")
  })

  it("provides inert A2UI callbacks while allowing explicit overrides", () => {
    const onAction = jest.fn()
    const component = { id: "text", component: "Text", text: "Hello" } as const
    const props = makeA2UIProps(component, { onAction })

    props.onAction("open", { componentId: "text" })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(props.renderChild("missing")).toBeNull()
  })
})

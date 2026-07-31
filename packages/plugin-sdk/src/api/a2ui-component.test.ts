import * as sdk from "./a2ui-component"
import type {
  A2UIPluginComponentDef,
  A2UIPluginComponentProps,
  PluginA2UIComponent,
} from "./a2ui-component"

describe("plugin-sdk api/a2ui-component", () => {
  it("re-exports the A2UI component authoring helper", () => {
    expect(typeof sdk.defineA2UIComponent).toBe("function")

    const def = sdk.defineA2UIComponent({
      type: "example.card",
      name: "Example Card",
      category: "display",
      propsSchema: { type: "object", properties: { title: { type: "string" } } },
      supportsChildren: true,
    })

    expect(def.type).toBe("example.card")
    expect(def.supportsChildren).toBe(true)
  })

  it("re-exports A2UI component contribution types", () => {
    const assertTypes = <
      _T extends A2UIPluginComponentDef | PluginA2UIComponent | A2UIPluginComponentProps,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})

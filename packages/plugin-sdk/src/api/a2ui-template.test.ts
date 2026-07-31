import * as sdk from "./a2ui-template"
import type { A2UIComponent, A2UISurfaceType, A2UITemplateDef } from "./a2ui-template"

describe("plugin-sdk api/a2ui-template", () => {
  it("re-exports the A2UI template authoring helper", () => {
    expect(typeof sdk.defineA2UITemplate).toBe("function")

    const def = sdk.defineA2UITemplate({
      id: "status-panel",
      name: "Status Panel",
      surfaceType: "panel",
      components: [],
      dataModel: { status: "ready" },
    })

    expect(def.id).toBe("status-panel")
    expect(def.surfaceType).toBe("panel")
  })

  it("re-exports A2UI template and component tree types", () => {
    const assertTypes = <_T extends A2UITemplateDef | A2UIComponent | A2UISurfaceType>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})

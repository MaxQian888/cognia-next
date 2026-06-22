import * as sdk from "./configuration"
import type { PluginConfigAPI, PluginConfigProperty, PluginConfigSchema } from "./configuration"

describe("plugin-sdk api/configuration", () => {
  it("re-exports the configuration authoring helper", () => {
    expect(typeof sdk.defineConfiguration).toBe("function")

    const schema = sdk.defineConfiguration({
      type: "object",
      required: ["model"],
      properties: {
        model: {
          type: "string",
          title: "Model",
          default: "default",
        },
      },
    })

    expect(schema.properties.model.default).toBe("default")
  })

  it("re-exports configuration schema and runtime API types", () => {
    const assertTypes = <
      _T extends PluginConfigSchema | PluginConfigProperty | PluginConfigAPI,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})

import * as sdk from "./connector"

describe("plugin-sdk: api/connector", () => {
  it("re-exports the defineConnector authoring helper", () => {
    expect(typeof sdk.defineConnector).toBe("function")
  })

  it("defineConnector is a typesafe identity function", () => {
    const def = sdk.defineConnector({
      type: "telegram",
      factory: "createTelegramAdapter",
      transportModes: ["polling", "webhook"],
      configSchema: { type: "object", properties: { token: { type: "string" } } },
    })
    expect(def.type).toBe("telegram")
    expect(def.factory).toBe("createTelegramAdapter")
  })
})

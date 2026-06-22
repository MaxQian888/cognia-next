import { defineConnector } from "./define-connector"

describe("defineConnector", () => {
  it("returns the connector definition unchanged (pure pass-through)", () => {
    const c = defineConnector({
      type: "telegram",
      factory: "createTelegramAdapter",
      configSchema: { type: "object", properties: { token: { type: "string" } } },
      transportModes: ["polling", "webhook"],
    })
    expect(c).toEqual({
      type: "telegram",
      factory: "createTelegramAdapter",
      configSchema: { type: "object", properties: { token: { type: "string" } } },
      transportModes: ["polling", "webhook"],
    })
  })

  it("preserves the optional defaultTrigger", () => {
    const c = defineConnector({
      type: "discord",
      factory: "createDiscordAdapter",
      configSchema: {},
      transportModes: ["gateway"],
      defaultTrigger: { mode: "mention" },
    })
    expect(c.defaultTrigger).toEqual({ mode: "mention" })
  })
})

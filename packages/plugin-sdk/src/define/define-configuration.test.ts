import { defineConfiguration } from "./define-configuration"

describe("defineConfiguration", () => {
  it("returns the config schema unchanged (pure pass-through)", () => {
    const schema = defineConfiguration({
      type: "object",
      properties: {
        apiKey: { type: "string", title: "API key", order: 1 },
        retries: { type: "integer", default: 3, minimum: 0, order: 2 },
        mode: {
          type: "string",
          enum: ["fast", "slow"],
          enumDescriptions: ["Low latency", "Cheaper"],
          default: "fast",
        },
      },
      required: ["apiKey"],
    })
    expect(schema.properties.retries.default).toBe(3)
    expect(schema.required).toEqual(["apiKey"])
  })
})

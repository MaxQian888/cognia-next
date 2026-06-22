import {
  COMMON_CONNECTION_PARAMETERS,
  COMMON_INFERENCE_PARAMETERS,
  PROVIDER_SCHEMAS,
  getSchemaForProvider,
} from "./provider-parameter-schemas"

describe("provider parameter schema registry", () => {
  it("includes common inference and connection parameters for built-in providers", () => {
    const openai = getSchemaForProvider("openai")

    expect(openai.providerName).toBe("OpenAI")
    expect(openai.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "temperature", category: "inference" }),
        expect.objectContaining({ key: "connection.timeout", category: "connection" }),
      ])
    )
    expect(COMMON_INFERENCE_PARAMETERS.some((parameter) => parameter.key === "maxTokens")).toBe(
      true
    )
    expect(
      COMMON_CONNECTION_PARAMETERS.some((parameter) => parameter.key === "connection.maxRetries")
    ).toBe(true)
  })

  it("inherits a custom provider schema from its protocol", () => {
    const custom = getSchemaForProvider("custom-openai", {
      "custom-openai": { apiProtocol: "openai", name: "Custom OpenAI" },
    })

    expect(custom.providerId).toBe("custom-openai")
    expect(custom.providerName).toBe("Custom OpenAI")
    expect(custom.parameters.map((parameter) => parameter.key)).toEqual(
      expect.arrayContaining(PROVIDER_SCHEMAS.openai.parameters.map((parameter) => parameter.key))
    )
  })

  it("falls back to common parameters for unknown providers", () => {
    const unknown = getSchemaForProvider("unknown-provider")

    expect(unknown.providerId).toBe("unknown-provider")
    expect(unknown.parameters.map((parameter) => parameter.key)).toEqual(
      expect.arrayContaining(["temperature", "connection.timeout"])
    )
  })
})

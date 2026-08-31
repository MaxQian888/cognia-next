import {
  COMMON_CONNECTION_PARAMETERS,
  COMMON_INFERENCE_PARAMETERS,
  PROVIDER_SCHEMAS,
  getSchemaForProvider,
} from "./provider-parameter-schemas"
import { BUILT_IN_PROVIDER_IDS } from "@cognia/provider-types/built-in-provider-catalog"

describe("provider parameter schema registry", () => {
  it("includes common inference and connection parameters for built-in providers", () => {
    const openai = getSchemaForProvider("openai")

    expect(openai.providerName).toBe("OpenAI")
    expect(openai.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "temperature", category: "inference" }),
        expect.objectContaining({ key: "connection.maxRetries", category: "connection" }),
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
      expect.arrayContaining(["temperature", "connection.maxRetries"])
    )
  })

  it("keeps every registered schema keyed by a real built-in provider id", () => {
    const builtInIds = new Set<string>(BUILT_IN_PROVIDER_IDS)

    for (const [registryId, schema] of Object.entries(PROVIDER_SCHEMAS)) {
      expect(schema.providerId).toBe(registryId)
      expect(builtInIds.has(registryId)).toBe(true)
    }
  })

  it("resolves Together AI through the catalog id without unsupported transport options", () => {
    const together = getSchemaForProvider("togetherai")

    expect(together.providerId).toBe("togetherai")
    expect(together.parameters.some((parameter) => parameter.key.startsWith("togetherAi."))).toBe(
      false
    )
  })

  it("exposes provider concurrency as a validated connection parameter", () => {
    expect(COMMON_CONNECTION_PARAMETERS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "connection.concurrentLimit",
          category: "connection",
          validation: expect.objectContaining({ min: 1 }),
        }),
      ])
    )
  })

  it("does not advertise native Ollama request options on the OpenAI-compatible transport", () => {
    expect(
      getSchemaForProvider("ollama").parameters.some((parameter) =>
        parameter.key.startsWith("ollama.")
      )
    ).toBe(false)
  })

  it("does not advertise connection controls without a runtime consumer", () => {
    const keys = COMMON_CONNECTION_PARAMETERS.map((parameter) => parameter.key)

    expect(keys).toEqual(["connection.maxRetries", "connection.concurrentLimit"])
  })
})

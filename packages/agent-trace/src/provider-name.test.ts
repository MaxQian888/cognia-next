import { providerNameFromId, isWellKnownProviderName } from "./provider-name"

describe("providerNameFromId", () => {
  it("passes through ids that already equal an OTel well-known value", () => {
    expect(providerNameFromId("anthropic")).toBe("anthropic")
    expect(providerNameFromId("openai")).toBe("openai")
    expect(providerNameFromId("deepseek")).toBe("deepseek")
    expect(providerNameFromId("groq")).toBe("groq")
    expect(providerNameFromId("cohere")).toBe("cohere")
  })

  it("maps ids whose well-known value differs from the id", () => {
    expect(providerNameFromId("google")).toBe("gcp.gemini")
    expect(providerNameFromId("gemini")).toBe("gcp.gemini")
    expect(providerNameFromId("vertex")).toBe("gcp.vertex_ai")
    expect(providerNameFromId("bedrock")).toBe("aws.bedrock")
    expect(providerNameFromId("azure")).toBe("azure.ai.openai")
    expect(providerNameFromId("mistral")).toBe("mistral_ai")
    expect(providerNameFromId("xai")).toBe("x_ai")
    expect(providerNameFromId("watsonx")).toBe("ibm.watsonx.ai")
  })

  it("emits an unrecognized provider id verbatim rather than mislabelling it", () => {
    // The regression this module exists for: every one of these used to report
    // as "openai", so provider-keyed cost and latency rollups were wrong.
    expect(providerNameFromId("zhipu")).toBe("zhipu")
    expect(providerNameFromId("ollama")).toBe("ollama")
    expect(providerNameFromId("openrouter")).toBe("openrouter")
    expect(providerNameFromId("togetherai")).toBe("togetherai")
    expect(providerNameFromId("minimax")).toBe("minimax")
    expect(providerNameFromId("lmstudio")).toBe("lmstudio")
  })

  it("normalizes case and surrounding whitespace", () => {
    expect(providerNameFromId("  Google ")).toBe("gcp.gemini")
    expect(providerNameFromId("DeepSeek")).toBe("deepseek")
    expect(providerNameFromId("ZHIPU")).toBe("zhipu")
  })

  it("falls back to openai only when the id is missing or blank", () => {
    expect(providerNameFromId(undefined)).toBe("openai")
    expect(providerNameFromId("")).toBe("openai")
    expect(providerNameFromId("   ")).toBe("openai")
  })
})

describe("isWellKnownProviderName", () => {
  it("recognizes the OTel GenAI value set", () => {
    expect(isWellKnownProviderName("anthropic")).toBe(true)
    expect(isWellKnownProviderName("gcp.vertex_ai")).toBe(true)
    expect(isWellKnownProviderName("ibm.watsonx.ai")).toBe(true)
  })

  it("rejects custom and vendor values", () => {
    expect(isWellKnownProviderName("zhipu")).toBe(false)
    expect(isWellKnownProviderName("cognia.workflow")).toBe(false)
    expect(isWellKnownProviderName("google")).toBe(false)
  })
})

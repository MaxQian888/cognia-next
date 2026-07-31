import {
  DEPLOYMENT_KEY_SEPARATOR,
  DEPLOYMENT_MODEL_WILDCARD,
  deploymentKeyOf,
  deploymentKeyOfEntry,
  parseDeploymentKey,
  providerIdOfDeploymentKey,
  wildcardDeploymentKey,
} from "./deployment"

describe("deploymentKeyOf", () => {
  it("serializes provider + model", () => {
    expect(deploymentKeyOf({ providerId: "openai", modelId: "gpt-4o" })).toBe("openai::gpt-4o")
  })

  it("serializes the optional keyId as a third segment", () => {
    expect(deploymentKeyOf({ providerId: "openai", modelId: "gpt-4o", keyId: "k1" })).toBe(
      "openai::gpt-4o::k1"
    )
  })

  it("keeps single colons inside ids intact (ollama tags)", () => {
    expect(deploymentKeyOf({ providerId: "ollama", modelId: "llama3:8b" })).toBe(
      "ollama::llama3:8b"
    )
  })

  it("keeps slashes inside ids intact (openrouter models)", () => {
    expect(deploymentKeyOf({ providerId: "openrouter", modelId: "meta/llama-3-70b" })).toBe(
      "openrouter::meta/llama-3-70b"
    )
  })

  it("rejects empty segments", () => {
    expect(deploymentKeyOf({ providerId: "", modelId: "m" })).toBeNull()
    expect(deploymentKeyOf({ providerId: "p", modelId: "" })).toBeNull()
    expect(deploymentKeyOf({ providerId: "p", modelId: "m", keyId: "" })).toBeNull()
  })

  it("rejects segments containing the separator", () => {
    expect(
      deploymentKeyOf({ providerId: "p", modelId: `a${DEPLOYMENT_KEY_SEPARATOR}b` })
    ).toBeNull()
    expect(deploymentKeyOf({ providerId: `p${DEPLOYMENT_KEY_SEPARATOR}`, modelId: "m" })).toBeNull()
    expect(deploymentKeyOf({ providerId: "p", modelId: "m", keyId: "k::1" })).toBeNull()
  })
})

describe("parseDeploymentKey", () => {
  it("round-trips two-segment keys", () => {
    const key = deploymentKeyOf({ providerId: "groq", modelId: "llama-3.3-70b" })!
    expect(parseDeploymentKey(key)).toEqual({ providerId: "groq", modelId: "llama-3.3-70b" })
  })

  it("round-trips three-segment keys", () => {
    const key = deploymentKeyOf({ providerId: "openai", modelId: "gpt-4o", keyId: "k2" })!
    expect(parseDeploymentKey(key)).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      keyId: "k2",
    })
  })

  it("round-trips ids with inner single colons", () => {
    const key = deploymentKeyOf({ providerId: "ollama", modelId: "llama3:8b" })!
    expect(parseDeploymentKey(key)).toEqual({ providerId: "ollama", modelId: "llama3:8b" })
  })

  it("rejects malformed input", () => {
    expect(parseDeploymentKey("")).toBeNull()
    expect(parseDeploymentKey("just-a-provider")).toBeNull()
    expect(parseDeploymentKey("a::b::c::d")).toBeNull()
    expect(parseDeploymentKey("a::::b")).toBeNull()
    expect(parseDeploymentKey("::model")).toBeNull()
    expect(parseDeploymentKey("provider::")).toBeNull()
  })
})

describe("deploymentKeyOfEntry", () => {
  it("derives the key from a mapping entry without keyId", () => {
    expect(deploymentKeyOfEntry({ providerId: "deepseek", modelId: "deepseek-chat" })).toBe(
      "deepseek::deepseek-chat"
    )
  })
})

describe("wildcardDeploymentKey", () => {
  it("builds the provider-only wildcard key", () => {
    expect(wildcardDeploymentKey("openai")).toBe(`openai::${DEPLOYMENT_MODEL_WILDCARD}`)
  })

  it("parses back with the wildcard modelId", () => {
    expect(parseDeploymentKey(wildcardDeploymentKey("openai")!)).toEqual({
      providerId: "openai",
      modelId: DEPLOYMENT_MODEL_WILDCARD,
    })
  })

  it("rejects an unencodable provider", () => {
    expect(wildcardDeploymentKey("a::b")).toBeNull()
  })
})

describe("providerIdOfDeploymentKey", () => {
  it("extracts the provider segment", () => {
    expect(providerIdOfDeploymentKey("openai::gpt-4o")).toBe("openai")
    expect(providerIdOfDeploymentKey("openai::gpt-4o::k1")).toBe("openai")
  })

  it("returns null for malformed keys", () => {
    expect(providerIdOfDeploymentKey("garbage")).toBeNull()
  })
})

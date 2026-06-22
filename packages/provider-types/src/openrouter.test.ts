import {
  BYOK_PROVIDER_NAMES,
  COMPLEX_BYOK_PROVIDERS,
  SIMPLE_BYOK_PROVIDERS,
  isAzureBYOKConfig,
  isBedrockCredentials,
  isSimpleBYOKConfig,
  isVertexBYOKConfig,
} from "./openrouter"

describe("OpenRouter BYOK guards", () => {
  it("recognizes simple and complex BYOK credential shapes", () => {
    expect(isSimpleBYOKConfig("sk-openai")).toBe(true)
    expect(
      isAzureBYOKConfig({
        model_slug: "openai/gpt-4o",
        endpoint_url: "https://resource.openai.azure.com",
        api_key: "key",
        model_id: "gpt-4o",
      })
    ).toBe(true)
    expect(
      isBedrockCredentials({ accessKeyId: "id", secretAccessKey: "secret", region: "us" })
    ).toBe(true)
    expect(
      isVertexBYOKConfig({
        type: "service_account",
        project_id: "p",
        private_key_id: "kid",
        private_key: "key",
        client_email: "svc@example.com",
        client_id: "cid",
        auth_uri: "auth",
        token_uri: "token",
        auth_provider_x509_cert_url: "certs",
        client_x509_cert_url: "client",
        universe_domain: "googleapis.com",
      })
    ).toBe(true)
  })
})

describe("OpenRouter BYOK catalogs", () => {
  it("partitions simple and complex providers", () => {
    expect(SIMPLE_BYOK_PROVIDERS).toEqual(["openai", "anthropic", "mistral", "cohere", "groq"])
    expect(COMPLEX_BYOK_PROVIDERS).toEqual(["azure", "bedrock", "vertex"])
    expect(BYOK_PROVIDER_NAMES.azure).toBe("Azure AI Services")
  })
})

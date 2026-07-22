import { testAndDiscoverBedrock } from "./bedrock-connection"

describe("testAndDiscoverBedrock", () => {
  it("uses the default-chain sidecar model and merges account-aware discovery", async () => {
    const generateText = jest.fn().mockResolvedValue({ text: "OK" })
    const discover = jest
      .fn()
      .mockResolvedValue([{ id: "us.amazon.nova-lite-v1:0", name: "US Nova Lite" }])

    const result = await testAndDiscoverBedrock(
      {
        providerId: "bedrock",
        enabled: true,
        defaultModel: "us.amazon.nova-lite-v1:0",
        bedrock: { authMode: "default-chain", region: "us-east-1", profile: "engineering" },
      },
      { generateText, discover }
    )

    expect(result.test.success).toBe(true)
    expect(result.models).toEqual([{ id: "us.amazon.nova-lite-v1:0", name: "US Nova Lite" }])
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ bedrockAuthMode: "default-chain", profile: "engineering" })
    )
  })

  it("tests API-key mode without calling the IAM control-plane discovery API", async () => {
    const generateText = jest.fn().mockResolvedValue({ text: "OK" })
    const discover = jest.fn()
    const result = await testAndDiscoverBedrock(
      {
        providerId: "bedrock",
        enabled: true,
        defaultModel: "amazon.nova-lite-v1:0",
        bedrock: {
          authMode: "api-key",
          region: "us-east-1",
          apiKey: "bedrock-secret",
        },
      },
      { generateText, discover }
    )
    expect(result.test.success).toBe(true)
    expect(discover).not.toHaveBeenCalled()
  })

  it("returns actionable validation failures without echoing IAM secrets", async () => {
    const result = await testAndDiscoverBedrock({
      providerId: "bedrock",
      enabled: true,
      defaultModel: "us.amazon.nova-lite-v1:0",
      bedrock: {
        authMode: "iam",
        region: "",
        accessKeyId: "AKIA-DO-NOT-ECHO",
        secretAccessKey: "secret-do-not-echo",
      },
    })
    expect(result.test.success).toBe(false)
    expect(result.test.message).toContain("region")
    expect(JSON.stringify(result)).not.toContain("AKIA-DO-NOT-ECHO")
    expect(JSON.stringify(result)).not.toContain("secret-do-not-echo")
  })
})

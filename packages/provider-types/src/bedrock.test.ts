import { validateBedrockConnectionSettings } from "./bedrock"

describe("validateBedrockConnectionSettings", () => {
  it.each([
    [{ authMode: "api-key", region: "us-east-1", apiKey: "bedrock-key" }],
    [
      {
        authMode: "iam",
        region: "eu-west-1",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "session",
      },
    ],
    [{ authMode: "default-chain", region: "ap-southeast-1", profile: "engineering" }],
  ] as const)("accepts a complete Bedrock configuration", (settings) => {
    expect(validateBedrockConnectionSettings(settings)).toEqual({ valid: true, issues: [] })
  })

  it("reports mode-specific missing fields without echoing secret values", () => {
    const result = validateBedrockConnectionSettings({
      authMode: "iam",
      region: "",
      accessKeyId: "AKIA-DO-NOT-ECHO",
      secretAccessKey: "secret-do-not-echo",
    })

    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.field)).toEqual(["region"])
    expect(JSON.stringify(result)).not.toContain("AKIA-DO-NOT-ECHO")
    expect(JSON.stringify(result)).not.toContain("secret-do-not-echo")
  })

  it("requires both explicit IAM credential fields", () => {
    const result = validateBedrockConnectionSettings({
      authMode: "iam",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
    })

    expect(result.issues).toEqual([
      { field: "secretAccessKey", code: "required", message: "Secret access key is required." },
    ])
  })
})

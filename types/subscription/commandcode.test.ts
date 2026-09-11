import { COMMANDCODE_DEFAULT_BASE_URL, toCommandCodeProviderCredential } from "./commandcode"
import { providerIdForCredential, variantOf } from "./credential"

describe("CommandCode credential contract", () => {
  it("preserves API key and optional gateway without inventing OAuth fields", () => {
    const credential = toCommandCodeProviderCredential({
      accessToken: "test-key",
      storedAtMs: 123,
      baseUrl: "https://relay.example/v1",
    })
    expect(credential).toEqual({
      provider: "commandcode",
      accessToken: "test-key",
      storedAtMs: 123,
      baseUrl: "https://relay.example/v1",
    })
    expect(providerIdForCredential(credential)).toBe("commandcode")
    expect(variantOf(credential)).toBe("commandcode")
  })

  it("uses the documented provider gateway", () => {
    expect(COMMANDCODE_DEFAULT_BASE_URL).toBe("https://api.commandcode.ai/provider/v1")
  })
})

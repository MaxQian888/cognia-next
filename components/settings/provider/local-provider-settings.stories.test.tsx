import meta, { Default, WithOllamaEnabled } from "./local-provider-settings.stories"

describe("LocalProviderSettings stories", () => {
  it("binds the unified local-provider surface to Ollama", () => {
    expect(meta.args).toEqual({ providerId: "ollama" })
    expect(Default).toEqual({})
    expect(WithOllamaEnabled.beforeEach).toEqual(expect.any(Function))
  })
})

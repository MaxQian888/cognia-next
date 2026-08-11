import {
  AiPromptConfig,
  AiCouncilConfig,
  EnsembleConfig,
  AiClassifyConfig,
  AiExtractConfig,
  AiEmbedConfig,
  BrowserModelConfig,
} from "./ai-forms"

describe("ai-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        AiPromptConfig,
        AiCouncilConfig,
        EnsembleConfig,
        AiClassifyConfig,
        AiExtractConfig,
        AiEmbedConfig,
        BrowserModelConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

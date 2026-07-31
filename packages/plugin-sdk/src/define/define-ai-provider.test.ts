import { defineAiProvider } from "./define-ai-provider"

describe("defineAiProvider", () => {
  it("returns the AI provider contribution unchanged", () => {
    const def = {
      id: "local-llm",
      kind: "llm" as const,
      label: "Local LLM",
      models: ["local-small"],
      entry: "providers/local.ts",
      export: "createProvider",
    }

    expect(defineAiProvider(def)).toBe(def)
  })
})

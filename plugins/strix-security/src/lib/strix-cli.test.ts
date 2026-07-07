import { buildStrixCommand, buildStrixEnv } from "./strix-cli"

describe("buildStrixCommand", () => {
  it("builds a non-interactive scan with an escaped target", () => {
    expect(buildStrixCommand({ target: "https://example.com" })).toBe(
      "strix -n --target 'https://example.com'"
    )
  })

  it("escapes an injection attempt in the target", () => {
    expect(buildStrixCommand({ target: "x; rm -rf /" })).toBe("strix -n --target 'x; rm -rf /'")
  })

  it("does not put model/apiKey on the command line", () => {
    const cmd = buildStrixCommand({ target: "x", model: "openai/gpt-5", apiKey: "secret" })
    expect(cmd).not.toContain("openai/gpt-5")
    expect(cmd).not.toContain("secret")
  })
})

describe("buildStrixEnv", () => {
  it("is empty when nothing is overridden", () => {
    expect(buildStrixEnv({ target: "x" })).toEqual({})
  })

  it("sets STRIX_LLM when a model is given", () => {
    expect(buildStrixEnv({ target: "x", model: " openai/gpt-5 " })).toEqual({
      STRIX_LLM: "openai/gpt-5",
    })
  })

  it("sets LLM_API_KEY when an api key is given", () => {
    expect(buildStrixEnv({ target: "x", apiKey: "k" })).toEqual({ LLM_API_KEY: "k" })
  })

  it("ignores blank overrides", () => {
    expect(buildStrixEnv({ target: "x", model: "   ", apiKey: "" })).toEqual({})
  })
})

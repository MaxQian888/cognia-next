import {
  OLLAMA_EMBEDDING_MODELS,
  POPULAR_OLLAMA_MODELS,
  formatModelSize,
  formatPullProgress,
  parseModelName,
} from "./ollama"

describe("Ollama model constants", () => {
  it("includes embedding and popular chat model defaults", () => {
    expect(OLLAMA_EMBEDDING_MODELS).toContain("nomic-embed-text")
    expect(POPULAR_OLLAMA_MODELS.some((model) => model.name === "llama3.2")).toBe(true)
  })
})

describe("formatModelSize", () => {
  it("formats bytes with binary units", () => {
    expect(formatModelSize(0)).toBe("0 B")
    expect(formatModelSize(1024)).toBe("1 KB")
    expect(formatModelSize(1024 * 1024 * 4.7)).toBe("4.7 MB")
  })
})

describe("formatPullProgress", () => {
  it("returns status text when byte totals are unavailable", () => {
    expect(formatPullProgress({ model: "llama3", status: "pulling manifest" })).toEqual({
      percentage: 0,
      text: "pulling manifest",
    })
  })

  it("formats completed bytes and percentage", () => {
    expect(
      formatPullProgress({
        model: "llama3",
        status: "downloading",
        completed: 512,
        total: 1024,
      })
    ).toEqual({ percentage: 50, text: "downloading - 512 B / 1 KB (50%)" })
  })
})

describe("parseModelName", () => {
  it("splits tags and defaults missing tags to latest", () => {
    expect(parseModelName("llama3:8b")).toEqual({ name: "llama3", tag: "8b" })
    expect(parseModelName("llama3")).toEqual({ name: "llama3", tag: "latest" })
  })
})

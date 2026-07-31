import { optimizeSearchQuery, isSearchRelevantQuery } from "./search-query-optimizer"

describe("optimizeSearchQuery", () => {
  it("returns empty string for empty input", () => {
    expect(optimizeSearchQuery("")).toBe("")
    expect(optimizeSearchQuery("   ")).toBe("")
  })

  it("preserves short queries", () => {
    expect(optimizeSearchQuery("react hooks")).toBe("react hooks")
  })

  it("removes a single English filler prefix from the start", () => {
    // The cleaner only strips one leading filler match; nested phrases stay.
    expect(optimizeSearchQuery("Please tell me about TypeScript")).toBe("tell me about TypeScript")
    expect(optimizeSearchQuery("can you explain quantum computing")).toBe(
      "explain quantum computing"
    )
  })

  it("removes a single Chinese filler prefix from the start", () => {
    expect(optimizeSearchQuery("请介绍一下 React")).toBe("介绍一下 React")
    expect(optimizeSearchQuery("帮我解释 hooks")).toBe("解释 hooks")
  })

  it("trims trailing thanks", () => {
    expect(optimizeSearchQuery("React vs Vue thanks")).toBe("React vs Vue")
    expect(optimizeSearchQuery("React vs Vue 谢谢")).toBe("React vs Vue")
  })

  it("collapses internal whitespace", () => {
    expect(optimizeSearchQuery("react    hooks    tutorial")).toBe("react hooks tutorial")
  })

  it("strips trailing period/exclamation but not question mark", () => {
    // ? is preserved (the cleaner only strips . 。 ! ！)
    expect(optimizeSearchQuery("what is React?")).toBe("React?")
    expect(optimizeSearchQuery("Tell me about TypeScript.")).toBe("TypeScript")
    expect(optimizeSearchQuery("Tell me about TypeScript！")).toBe("TypeScript")
  })

  it("extracts a sentence from very long input", () => {
    const longInput =
      "I am working on a project. " +
      "What is the difference between React and Vue? " +
      "Please give me detailed comparison." +
      " ".repeat(300)
    const result = optimizeSearchQuery(longInput)
    expect(result.length).toBeLessThanOrEqual(300)
    expect(result.length).toBeGreaterThan(0)
  })

  it("falls back to first sentence when no question pattern matches", () => {
    const longInput =
      "TypeScript provides static typing. " +
      "It compiles to JavaScript. " +
      "Many teams adopt it. ".repeat(50)
    const result = optimizeSearchQuery(longInput)
    expect(result.length).toBeLessThanOrEqual(300)
  })

  it("truncates at word boundary as last resort", () => {
    const longInput = "supercalifragilistic ".repeat(50)
    const result = optimizeSearchQuery(longInput)
    expect(result.length).toBeLessThanOrEqual(300)
  })

  it("falls back to truncated text when no space found near end", () => {
    const noSpace = "a".repeat(400)
    const result = optimizeSearchQuery(noSpace)
    expect(result.length).toBeLessThanOrEqual(300)
  })

  it("falls back to original when cleaning empties the query", () => {
    const result = optimizeSearchQuery("please")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("isSearchRelevantQuery", () => {
  it("returns false for empty or very short input", () => {
    expect(isSearchRelevantQuery("")).toBe(false)
    expect(isSearchRelevantQuery("hi")).toBe(false)
  })

  it("recognizes recency keywords", () => {
    expect(isSearchRelevantQuery("latest react release")).toBe(true)
    expect(isSearchRelevantQuery("最新的 react 版本")).toBe(true)
  })

  it("recognizes year mentions", () => {
    expect(isSearchRelevantQuery("Best laptops in 2024")).toBe(true)
  })

  it("recognizes how-to and comparison patterns", () => {
    expect(isSearchRelevantQuery("how to set up Docker")).toBe(true)
    expect(isSearchRelevantQuery("React vs Vue comparison")).toBe(true)
  })

  it("recognizes domain-specific keywords", () => {
    expect(isSearchRelevantQuery("Apple stock price today")).toBe(true)
    expect(isSearchRelevantQuery("Beijing weather forecast")).toBe(true)
  })

  it("returns false for general chitchat", () => {
    expect(isSearchRelevantQuery("hello there friend")).toBe(false)
  })
})

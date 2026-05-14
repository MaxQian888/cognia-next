import { isGeminiExportShape, parseGeminiExport } from "./gemini"

describe("parseGeminiExport", () => {
  it("returns no sources for empty input", () => {
    expect(parseGeminiExport("", { twinId: "t1" })).toEqual([])
  })

  it("pairs each entry as User prompt + Gemini response", () => {
    const sources = parseGeminiExport(
      JSON.stringify([
        {
          header: "Gemini Apps",
          title: "Asked Gemini: explain RAG",
          products: ["Gemini Apps"],
          time: "2024-03-01T10:00:00Z",
          details: [{ text: "RAG stands for retrieval-augmented generation..." }],
        },
        {
          header: "Gemini Apps",
          title: "Asked Gemini: pros and cons of vector dbs",
          products: ["Gemini Apps"],
          time: "2024-03-01T10:05:00Z",
          subtitles: [{ name: "Pros: scale; Cons: cost" }],
        },
      ]),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    const text = sources[0].text
    expect(text).toContain("explain RAG")
    expect(text).toContain("RAG stands for")
    expect(text).toContain("pros and cons")
    expect(text).toContain("Pros: scale")
    expect(sources[0].baseMetadata?.speakers).toEqual(["User", "Gemini"])
    expect(sources[0].baseMetadata?.platform).toBe("gemini")
  })

  it("filters out non-Gemini Takeout entries", () => {
    const sources = parseGeminiExport(
      JSON.stringify([
        {
          title: "Searched Maps",
          products: ["Maps"],
          time: "2024-03-01T10:00:00Z",
        },
      ]),
      { twinId: "t1" }
    )
    expect(sources).toEqual([])
  })

  it("isGeminiExportShape recognises both products + header signals", () => {
    expect(isGeminiExportShape([{ products: ["Gemini Apps"] }])).toBe(true)
    expect(isGeminiExportShape([{ header: "Bard" }])).toBe(true)
    expect(isGeminiExportShape([{ products: ["Maps"] }])).toBe(false)
    expect(isGeminiExportShape(null)).toBe(false)
  })
})

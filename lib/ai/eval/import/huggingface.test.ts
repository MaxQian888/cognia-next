import { parseHuggingFaceUri, importHuggingFace } from "./huggingface"

let counter = 0
const deps = { datasetId: "d", capability: "chat", now: () => 1, id: () => `evc_${counter++}` }
beforeEach(() => {
  counter = 0
})

describe("parseHuggingFaceUri", () => {
  it("parses an hf:// uri with config + split", () => {
    expect(parseHuggingFaceUri("hf://datasets/owner/name?config=c&split=test")).toEqual({
      dataset: "owner/name",
      config: "c",
      split: "test",
    })
  })

  it("defaults config/split and accepts bare owner/name", () => {
    expect(parseHuggingFaceUri("owner/name")).toEqual({
      dataset: "owner/name",
      config: "default",
      split: "train",
    })
  })

  it("throws on an empty dataset", () => {
    expect(() => parseHuggingFaceUri("hf://datasets/")).toThrow(/missing dataset/)
  })
})

describe("importHuggingFace", () => {
  it("fetches rows and maps them via the field spec", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        rows: [{ row: { q: "hi", a: "yo" } }, { row: { q: "foo", a: "bar" } }],
      }),
    })) as unknown as typeof fetch
    const out = await importHuggingFace(
      "hf://datasets/o/n?split=test",
      { input: "q", expected: "a" },
      deps,
      {
        fetchImpl,
      }
    )
    expect(out.cases).toHaveLength(2)
    expect(out.cases[0].input).toBe("hi")
    expect(out.cases[0].reference?.expectedOutput).toBe("yo")
    // URL carries dataset/config/split + length cap
    const calledUrl = (fetchImpl as jest.Mock).mock.calls[0][0] as string
    expect(calledUrl).toContain("dataset=o%2Fn")
    expect(calledUrl).toContain("split=test")
    expect(calledUrl).toContain("length=100")
  })

  it("throws on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(importHuggingFace("o/n", { input: "q" }, deps, { fetchImpl })).rejects.toThrow(
      /HTTP 503/
    )
  })

  it("handles an empty rows payload", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch
    const out = await importHuggingFace("o/n", { input: "q" }, deps, { fetchImpl })
    expect(out.cases).toHaveLength(0)
  })
})

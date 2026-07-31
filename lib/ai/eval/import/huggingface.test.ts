import { parseHuggingFaceUri, importHuggingFace, fetchHuggingFaceSchema } from "./huggingface"

let counter = 0
const deps = { datasetId: "d", capability: "chat", now: () => 1, id: () => `evc_${counter++}` }
beforeEach(() => {
  counter = 0
})

/** A datasets-server stub that serves `total` rows across paged requests. */
function pagedFetch(total: number, extra: Record<string, unknown> = {}) {
  return jest.fn(async (url: string) => {
    const params = new URLSearchParams(url.split("?")[1])
    const offset = Number(params.get("offset"))
    const length = Number(params.get("length"))
    const rows = Array.from({ length: Math.max(0, Math.min(length, total - offset)) }, (_, i) => ({
      row: { q: `q${offset + i}`, a: `a${offset + i}`, ...extra },
    }))
    return { ok: true, status: 200, json: async () => ({ rows, num_rows_total: total }) }
  }) as unknown as typeof fetch
}

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

  it("pages past the server's 100-row cap to reach the requested limit", async () => {
    // The whole point: "import GSM8K's 1319-case test split" used to silently
    // mean "import the first 100".
    const fetchImpl = pagedFetch(1319)
    const out = await importHuggingFace("o/n?split=test", { input: "q", expected: "a" }, deps, {
      fetchImpl,
      limit: 250,
    })
    expect(out.cases).toHaveLength(250)
    expect(out.cases[249].input).toBe("q249")
    // 100 + 100 + 50
    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(3)
    expect((fetchImpl as jest.Mock).mock.calls[2][0]).toContain("length=50")
  })

  it("stops early when the split runs out instead of spinning", async () => {
    const fetchImpl = pagedFetch(140)
    const out = await importHuggingFace("o/n", { input: "q" }, deps, { fetchImpl, limit: 1000 })
    expect(out.cases).toHaveLength(140)
    expect((fetchImpl as jest.Mock).mock.calls).toHaveLength(2)
  })

  it("reports progress with the server-reported total", async () => {
    const seen: [number, number | undefined][] = []
    await importHuggingFace("o/n", { input: "q" }, deps, {
      fetchImpl: pagedFetch(250),
      limit: 250,
      onProgress: (fetched, total) => seen.push([fetched, total]),
    })
    expect(seen).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ])
  })

  it("stops between pages when aborted, keeping what it already pulled", async () => {
    const controller = new AbortController()
    const out = await importHuggingFace("o/n", { input: "q" }, deps, {
      fetchImpl: pagedFetch(1000),
      limit: 500,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    expect(out.cases).toHaveLength(100)
  })

  it("carries the URI's split onto every case", async () => {
    // Previously parsed and then thrown away, which is why the run dialog's
    // split filter never matched an imported case.
    const out = await importHuggingFace("o/n?split=test", { input: "q" }, deps, {
      fetchImpl: pagedFetch(3),
      limit: 3,
    })
    expect(out.cases.map((c) => c.split)).toEqual(["test", "test", "test"])
    expect(out.cases[0].source).toBe("synthetic")
  })

  it("lets a mapped split column win over the URI", async () => {
    const out = await importHuggingFace("o/n?split=train", { input: "q", split: "s" }, deps, {
      fetchImpl: pagedFetch(2, { s: "validation" }),
      limit: 2,
    })
    expect(out.cases.map((c) => c.split)).toEqual(["validation", "validation"])
  })

  it("stamps the grading rule onto every imported case", async () => {
    const out = await importHuggingFace(
      "o/n?split=test",
      { input: "q", expected: "a", grading: { mode: "numeric", pattern: "####\\s*(-?\\d+)" } },
      deps,
      { fetchImpl: pagedFetch(2), limit: 2 }
    )
    expect(out.cases[0].reference).toMatchObject({
      expectedOutput: "a0",
      grading: { mode: "numeric" },
    })
  })
})

describe("fetchHuggingFaceSchema", () => {
  function schemaFetch(
    splits: { config: string; split: string }[],
    columns = ["question", "answer"]
  ) {
    return jest.fn(async (url: string) => {
      if (url.includes("/splits")) {
        return { ok: true, status: 200, json: async () => ({ splits }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows: [{ row: Object.fromEntries(columns.map((c) => [c, `${c}-value`])) }],
        }),
      }
    }) as unknown as typeof fetch
  }

  it("returns the dataset's configs/splits plus real column names and sample rows", async () => {
    // This is what replaces the hardcoded `{input:"question", expected:"answer"}`
    // guess that made every other dataset import zero rows without an error.
    const fetchImpl = schemaFetch([
      { config: "main", split: "train" },
      { config: "main", split: "test" },
    ])
    const schema = await fetchHuggingFaceSchema("o/n?config=main&split=test", { fetchImpl })
    expect(schema.splits).toHaveLength(2)
    expect(schema.columns).toEqual(["question", "answer"])
    expect(schema.sampleRows).toHaveLength(1)
    expect(schema.ref).toEqual({ dataset: "o/n", config: "main", split: "test" })
  })

  it("falls back to the first published split when the requested one does not exist", async () => {
    // A bare `owner/name` defaults to config "default" / split "train", which
    // most datasets do not have — previewing nothing would be useless.
    const fetchImpl = schemaFetch([{ config: "main", split: "test" }])
    const schema = await fetchHuggingFaceSchema("o/n", { fetchImpl })
    expect(schema.ref).toEqual({ dataset: "o/n", config: "main", split: "test" })
  })

  it("tolerates a dataset that publishes no splits", async () => {
    const fetchImpl = schemaFetch([])
    const schema = await fetchHuggingFaceSchema("o/n", { fetchImpl })
    expect(schema.splits).toEqual([])
    expect(schema.ref).toEqual({ dataset: "o/n", config: "default", split: "train" })
  })

  it("throws on a non-ok splits response", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(fetchHuggingFaceSchema("o/n", { fetchImpl })).rejects.toThrow(/HTTP 404/)
  })
})

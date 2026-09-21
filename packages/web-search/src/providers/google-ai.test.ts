import {
  searchWithGoogleAI,
  getGroundedAnswerWithCitations,
  testGoogleAIConnection,
  supportsGoogleSearchGrounding,
  shouldUseLegacyRetrieval,
  addInlineCitations,
} from "./google-ai"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  googleAIFetch: (...a: unknown[]) => fetchMock(...a),
}))

function fakeResp(opts: { ok?: boolean; json?: unknown; statusText?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.ok === false ? 400 : 200,
    statusText: opts.statusText ?? "",
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(""),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithGoogleAI", () => {
  it("requires apiKey", async () => {
    await expect(searchWithGoogleAI("q", "")).rejects.toThrow(/required/)
  })

  it("maps grounding metadata into results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [
            {
              content: { parts: [{ text: "answer" }], role: "model" },
              groundingMetadata: {
                webSearchQueries: ["q"],
                groundingChunks: [
                  { web: { uri: "https://wikipedia.org/x", title: "Wiki" } },
                  { web: { uri: "https://github.com", title: "GH" } },
                ],
                groundingSupports: [
                  {
                    segment: { startIndex: 0, endIndex: 5, text: "answer" },
                    groundingChunkIndices: [0],
                  },
                ],
              },
            },
          ],
        },
      })
    )
    const r = await searchWithGoogleAI("q", "k")
    expect(r.provider).toBe("google-ai")
    expect(r.answer).toBe("answer")
    expect(r.results).toHaveLength(2)
    expect(r.results[0].source).toBe("wikipedia.org")
  })

  it("uses legacy retrieval when configured", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }],
        },
      })
    )
    await searchWithGoogleAI("q", "k", { useLegacyRetrieval: true })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0].google_search_retrieval).toBeDefined()
  })

  it("uses google_search by default", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }],
        },
      })
    )
    await searchWithGoogleAI("q", "k")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools[0].google_search).toBeDefined()
  })

  it("handles invalid URI gracefully", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [
            {
              content: { parts: [{ text: "answer" }], role: "model" },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "not a url", title: "Bad" } }],
              },
            },
          ],
        },
      })
    )
    const r = await searchWithGoogleAI("q", "k")
    expect(r.results).toHaveLength(1)
    expect(r.results[0].source).toBeUndefined()
  })

  it("throws when no candidate", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await expect(searchWithGoogleAI("q", "k")).rejects.toThrow(/No response/)
  })

  it("throws on non-ok HTTP", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, json: { error: { message: "bad" } } }))
    await expect(searchWithGoogleAI("q", "k")).rejects.toThrow(/Google AI/)
  })

  it("throws on data.error inline", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          error: { code: 400, message: "quota", status: "INVALID" },
        },
      })
    )
    await expect(searchWithGoogleAI("q", "k")).rejects.toThrow(/Google AI/)
  })

  it("limits results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [
            {
              content: { parts: [{ text: "answer" }], role: "model" },
              groundingMetadata: {
                groundingChunks: Array.from({ length: 5 }, (_, i) => ({
                  web: { uri: `https://x${i}.com`, title: `T${i}` },
                })),
              },
            },
          ],
        },
      })
    )
    const r = await searchWithGoogleAI("q", "k", { maxResults: 2 })
    expect(r.results).toHaveLength(2)
  })
})

describe("getGroundedAnswerWithCitations", () => {
  it("requires apiKey", async () => {
    await expect(getGroundedAnswerWithCitations("q", "")).rejects.toThrow(/required/)
  })

  it("returns answer, citedAnswer, and sources", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [
            {
              content: { parts: [{ text: "react is a library" }], role: "model" },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://react.dev", title: "React" } }],
                groundingSupports: [
                  {
                    segment: { startIndex: 0, endIndex: 17, text: "react is a library" },
                    groundingChunkIndices: [0],
                  },
                ],
              },
            },
          ],
        },
      })
    )
    const r = await getGroundedAnswerWithCitations("q", "k")
    expect(r.answer).toBe("react is a library")
    expect(r.citedAnswer).toContain("[1]")
    expect(r.sources).toHaveLength(1)
  })

  it("throws on non-ok HTTP", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, json: { error: { message: "bad" } } }))
    await expect(getGroundedAnswerWithCitations("q", "k")).rejects.toThrow(/Google AI/)
  })

  it("throws when no candidate", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await expect(getGroundedAnswerWithCitations("q", "k")).rejects.toThrow(/No response/)
  })
})

describe("addInlineCitations", () => {
  it("returns text unchanged when no metadata", () => {
    expect(addInlineCitations("hello", undefined)).toBe("hello")
  })

  it("returns text unchanged when missing supports/chunks", () => {
    expect(addInlineCitations("hello", { groundingChunks: [] })).toBe("hello")
  })

  it("inserts citation links at endIndex", () => {
    const out = addInlineCitations("hello world", {
      groundingChunks: [{ web: { uri: "https://x.com", title: "X" } }],
      groundingSupports: [
        {
          segment: { startIndex: 0, endIndex: 5, text: "hello" },
          groundingChunkIndices: [0],
        },
      ],
    })
    expect(out).toContain("[1](https://x.com)")
  })

  it("skips supports without indices", () => {
    const out = addInlineCitations("hello world", {
      groundingChunks: [{ web: { uri: "https://x.com", title: "X" } }],
      groundingSupports: [
        {
          segment: { startIndex: 0, endIndex: 5, text: "hello" },
          groundingChunkIndices: [],
        },
      ],
    })
    expect(out).toBe("hello world")
  })
})

describe("testGoogleAIConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }],
        },
      })
    )
    expect(await testGoogleAIConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testGoogleAIConnection("k")).toBe(false)
  })
})

describe("supportsGoogleSearchGrounding", () => {
  it("returns true for known model ids", () => {
    expect(supportsGoogleSearchGrounding("gemini-2.0-flash")).toBe(true)
    expect(supportsGoogleSearchGrounding("Gemini-1.5-Pro")).toBe(true)
  })

  it("returns false for unknown models", () => {
    expect(supportsGoogleSearchGrounding("claude-opus-4")).toBe(false)
  })
})

describe("shouldUseLegacyRetrieval", () => {
  it("flags 1.5 family", () => {
    expect(shouldUseLegacyRetrieval("gemini-1.5-pro")).toBe(true)
    expect(shouldUseLegacyRetrieval("gemini-2.0-flash")).toBe(false)
  })
})

// --- Generation seam (ADR-0188 D27) ------------------------------------------
// Every Google AI search is a Gemini generation, so the host can put it on the
// CallLedger through `options.generate`. With none injected the request body is
// exactly what it always was.

describe("google-ai generation seam", () => {
  const answered = {
    candidates: [
      {
        content: { parts: [{ text: "grounded answer" }], role: "model" },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: 8, text: "grounded" },
              groundingChunkIndices: [0],
            },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 40,
      totalTokenCount: 160,
      thoughtsTokenCount: 5,
      cachedContentTokenCount: 20,
    },
  }

  function bodyOf(call: number): Record<string, unknown> {
    const init = fetchMock.mock.calls[call][1] as { body: string }
    return JSON.parse(init.body) as Record<string, unknown>
  }

  it("sends the unchanged body when no seam is injected", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: answered }))

    await searchWithGoogleAI("q", "k")

    expect(Object.keys(bodyOf(0)).sort()).toEqual(["contents", "tools"])
  })

  it("reports the answer and Gemini's usage to the seam, and bounds the output", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: answered }))
    const seen: { stage: string; modelId: string; prompt: string }[] = []
    let reported: unknown

    const response = await searchWithGoogleAI("q", "k", {
      generate: async (request, send) => {
        seen.push({ stage: request.stage, modelId: request.modelId, prompt: request.prompt })
        const result = await send({ maxOutputTokens: 512, maxRetries: 0 })
        reported = result.usage
        return result.text
      },
    })

    expect(response.answer).toBe("grounded answer")
    expect(seen).toEqual([
      { stage: "web-search.google-ai", modelId: "gemini-2.0-flash", prompt: "q" },
    ])
    expect(bodyOf(0)).toMatchObject({ generationConfig: { maxOutputTokens: 512 } })
    // Inclusive totals, like the AI SDK's: thinking counts as output, cache reads
    // are already inside the prompt count.
    expect(reported).toEqual({ inputTokens: 120, outputTokens: 45, cachedInputTokens: 20 })
  })

  it("lets a refusing seam stop the search before any request goes out", async () => {
    await expect(
      searchWithGoogleAI("q", "k", {
        generate: async () => {
          throw new Error("Router + Fusion refused a web-search call: RUN_CAP_EXCEEDED")
        },
      })
    ).rejects.toThrow(/RUN_CAP_EXCEEDED/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("threads the seam through getGroundedAnswerWithCitations", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: answered }))
    const generate = jest.fn(async (_request, send) => (await send({})).text)

    const result = await getGroundedAnswerWithCitations("q", "k", { generate })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.answer).toBe("grounded answer")
  })

  it("leaves the user-initiated key probe unledgered by construction", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: answered }))
    const generate = jest.fn()

    // `options` never reach the probe: it tests one key on purpose (D27's named
    // provider-diagnostic exemption).
    await expect(testGoogleAIConnection("k")).resolves.toBe(true)
    expect(generate).not.toHaveBeenCalled()
  })
})

import { runPRReviewAgent, tryParseReviewJson } from "./review-pr-inline"

function fakeOctokit(responses: Record<string, unknown>): import("@octokit/core").Octokit {
  return {
    request: jest.fn(async (route: string) => responses[route] ?? { data: {} }),
  } as unknown as import("@octokit/core").Octokit
}

describe("tryParseReviewJson", () => {
  it("parses a clean JSON response", () => {
    const out = tryParseReviewJson(
      JSON.stringify({
        body: "looks fine",
        comments: [{ path: "a.ts", line: 5, body: "rename me" }],
      })
    )
    expect(out?.body).toBe("looks fine")
    expect(out?.comments).toEqual([{ path: "a.ts", line: 5, side: "RIGHT", body: "rename me" }])
  })

  it("strips markdown fences", () => {
    const out = tryParseReviewJson('```json\n{"body":"x","comments":[]}\n```')
    expect(out?.body).toBe("x")
    expect(out?.comments).toEqual([])
  })

  it("recovers JSON wrapped in prose", () => {
    const out = tryParseReviewJson(
      `Sure, here's my review:\n\n{"body":"ok","comments":[{"path":"a.ts","line":1,"body":"hi","side":"LEFT"}]}\n\nLet me know if you have questions.`
    )
    expect(out?.body).toBe("ok")
    expect(out?.comments).toEqual([{ path: "a.ts", line: 1, side: "LEFT", body: "hi" }])
  })

  it("filters malformed comment objects", () => {
    const out = tryParseReviewJson(
      JSON.stringify({
        body: "x",
        comments: [
          { path: "a.ts", line: 1, body: "ok" },
          { path: 5, line: 1, body: "wrong types" },
          null,
          { line: 5, body: "missing path" },
          { path: "b.ts", line: "not a number", body: "x" },
        ],
      })
    )
    expect(out?.comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "ok" }])
  })

  it("returns null on completely unparseable output", () => {
    expect(tryParseReviewJson("not json at all")).toBeNull()
    expect(tryParseReviewJson("")).toBeNull()
  })
})

describe("runPRReviewAgent", () => {
  function setup() {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": {
        data: [
          { filename: "a.ts", status: "modified", patch: "@@\n+const x = 1" },
          { filename: "b.ts", status: "added", patch: "@@\n+const y = 2" },
        ],
      },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": {
        data: { id: 9001 },
      },
    })
    return { octokit }
  }

  it("posts a structured review with inline comments when the LLM returns JSON", async () => {
    const { octokit } = setup()
    const complete = jest.fn(async () =>
      JSON.stringify({
        body: "Looks reasonable",
        comments: [{ path: "a.ts", line: 1, body: "use const" }],
      })
    )
    const createLlmClient = jest.fn(() => ({ complete })) as unknown as NonNullable<
      Parameters<typeof runPRReviewAgent>[2]
    >["createLlmClient"]

    const result = await runPRReviewAgent(
      {
        repoFullName: "o/r",
        prNumber: 7,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "k",
      },
      octokit,
      { createLlmClient }
    )

    expect(result).toMatchObject({
      reviewId: 9001,
      body: "Looks reasonable",
      commentCount: 1,
      filesAnalysed: 2,
      parsedStructured: true,
    })

    const reqMock = octokit.request as unknown as jest.Mock
    const reviewCall = reqMock.mock.calls.find((c) =>
      String(c[0]).includes("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")
    )
    expect(reviewCall?.[1]).toMatchObject({
      owner: "o",
      repo: "r",
      pull_number: 7,
      event: "COMMENT",
      body: "Looks reasonable",
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "use const" }],
    })
  })

  it("falls back to a body-only review when the LLM output isn't parseable JSON", async () => {
    const { octokit } = setup()
    const complete = jest.fn(async () => "Nice work overall. No structured findings.")
    const createLlmClient = jest.fn(() => ({ complete })) as unknown as NonNullable<
      Parameters<typeof runPRReviewAgent>[2]
    >["createLlmClient"]

    const result = await runPRReviewAgent(
      {
        repoFullName: "o/r",
        prNumber: 8,
        provider: "anthropic",
        model: "x",
        apiKey: "k",
      },
      octokit,
      { createLlmClient }
    )
    expect(result.parsedStructured).toBe(false)
    expect(result.commentCount).toBe(0)
    expect(result.body).toMatch(/Nice work overall/)
  })

  it("caps maxFiles at the hard ceiling", async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified" as const,
      patch: "@@\n+",
    }))
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": { data },
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { data: { id: 1 } },
    })
    const complete = jest.fn(async () => "{}")
    const createLlmClient = jest.fn(() => ({ complete })) as unknown as NonNullable<
      Parameters<typeof runPRReviewAgent>[2]
    >["createLlmClient"]

    const result = await runPRReviewAgent(
      {
        repoFullName: "o/r",
        prNumber: 9,
        provider: "anthropic",
        model: "x",
        apiKey: "k",
        maxFiles: 999,
      },
      octokit,
      { createLlmClient }
    )
    expect(result.filesAnalysed).toBe(30) // hard cap
  })

  it("limits inline comments to 8", async () => {
    const { octokit } = setup()
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      body: `nit ${i}`,
    }))
    const complete = jest.fn(async () => JSON.stringify({ body: "x", comments: fifteen }))
    const createLlmClient = jest.fn(() => ({ complete })) as unknown as NonNullable<
      Parameters<typeof runPRReviewAgent>[2]
    >["createLlmClient"]
    const result = await runPRReviewAgent(
      {
        repoFullName: "o/r",
        prNumber: 10,
        provider: "anthropic",
        model: "x",
        apiKey: "k",
      },
      octokit,
      { createLlmClient }
    )
    expect(result.commentCount).toBe(8)
  })
})

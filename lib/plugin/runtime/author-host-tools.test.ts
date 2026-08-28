/** @jest-environment node */
import { runAuthorCallableHostTool, notAuthorCallable } from "./author-host-tools"
import type { WebToolRunDeps } from "@/lib/claude/web-builtin-tools"

const searchResponse = {
  query: "cognia",
  provider: "tavily" as const,
  results: [{ title: "T", url: "https://t.test", content: "c", score: 0.9 }],
}

function deps(overrides: Partial<WebToolRunDeps> = {}): WebToolRunDeps {
  return {
    enabled: true,
    searchExecutor: async () => searchResponse,
    ...overrides,
  } as WebToolRunDeps
}

describe("promotion allowlist", () => {
  it("refuses a host-private tool with a stable code", async () => {
    const result = await runAuthorCallableHostTool("dispatch_agent", {}, deps())
    expect(result).toMatchObject({ ok: false, code: "not-author-callable" })
  })

  it("names the callable tools in the refusal so authors can self-correct", () => {
    expect(notAuthorCallable("spawn_task").error).toContain("web_search, web_fetch")
  })
})

describe("web_search", () => {
  it("returns the host's shaped search result", async () => {
    const result = (await runAuthorCallableHostTool(
      "web_search",
      { query: "cognia" },
      deps()
    )) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.provider).toBe("tavily")
    expect(result.results).toHaveLength(1)
  })

  it("reports a missing provider as `no-search-provider`, not a crash", async () => {
    const result = await runAuthorCallableHostTool(
      "web_search",
      { query: "cognia" },
      deps({ searchExecutor: undefined })
    )
    expect(result).toMatchObject({ ok: false, code: "no-search-provider" })
  })

  it("reports disabled web tools as `web-disabled`", async () => {
    const result = await runAuthorCallableHostTool(
      "web_search",
      { query: "cognia" },
      deps({ enabled: false })
    )
    expect(result).toMatchObject({ ok: false, code: "web-disabled" })
  })
})

describe("web_fetch", () => {
  it("threads the caller's signal over any ambient one", async () => {
    // A plugin cancelling its own run must cancel the fetch it started; the
    // deps' signal belongs to the surrounding turn, which may outlive it.
    const ambient = new AbortController()
    const caller = new AbortController()
    let seen: AbortSignal | undefined
    const result = await runAuthorCallableHostTool(
      "web_fetch",
      { url: "https://x.test" },
      deps({
        signal: ambient.signal,
        fetchImpl: (async (_url: string, _init?: RequestInit) => {
          throw new Error("network down")
        }) as unknown as typeof fetch,
        summarize: (async (text: string, _prompt: string, signal?: AbortSignal) => {
          seen = signal
          return text
        }) as never,
      }),
      { signal: caller.signal }
    )
    expect(result).toMatchObject({ ok: false, code: "execution-failed" })
    expect(seen).toBeUndefined()
  })

  it("refuses before dispatch when the caller already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = jest.fn()
    const result = await runAuthorCallableHostTool(
      "web_fetch",
      { url: "https://x.test" },
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      { signal: controller.signal }
    )
    expect(result).toMatchObject({ ok: false, code: "execution-failed" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("classifies an SSRF refusal as `blocked`, not a network failure", async () => {
    const result = await runAuthorCallableHostTool(
      "web_fetch",
      { url: "http://127.0.0.1/admin" },
      deps()
    )
    expect(result).toMatchObject({ ok: false, code: "blocked" })
  })

  it("classifies unredacted PII as `blocked` without touching the network", async () => {
    const fetchImpl = jest.fn()
    const result = await runAuthorCallableHostTool(
      "web_fetch",
      { url: "https://x.test", body: "contact alice@example.com" },
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    )
    expect(result).toMatchObject({ ok: false, code: "blocked" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

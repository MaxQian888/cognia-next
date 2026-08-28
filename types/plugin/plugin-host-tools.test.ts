import {
  PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS,
  isAuthorCallableHostTool,
  isPluginHostToolFailure,
  isPluginWebFetchSuccess,
  isPluginWebSearchSuccess,
  pluginWebFetchText,
  type PluginWebFetchSuccess,
} from "./plugin-host-tools"

describe("author-callable host tool allowlist", () => {
  it("admits exactly the two promoted web tools", () => {
    expect([...PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS]).toEqual(["web_search", "web_fetch"])
  })

  it("accepts the promoted names", () => {
    expect(isAuthorCallableHostTool("web_search")).toBe(true)
    expect(isAuthorCallableHostTool("web_fetch")).toBe(true)
  })

  it("refuses host-private tool names", () => {
    // The whole point of the allowlist: `ctx.agent.invokeTool` must not become
    // a back door onto the host's internal agent-loop tools.
    for (const name of ["spawn_task", "dispatch_agent", "ask_user", "run_workflow_typed"]) {
      expect(isAuthorCallableHostTool(name)).toBe(false)
    }
  })
})

describe("isPluginHostToolFailure", () => {
  it("narrows a structured failure", () => {
    expect(isPluginHostToolFailure({ ok: false, error: "nope", code: "web-disabled" })).toBe(true)
  })

  it("does not treat an HTTP failure as a tool failure", () => {
    // `web_fetch` mirrors the HTTP outcome on `ok`, so a 404 carries
    // `ok: false` WITHOUT an `error` — misreading it as a tool failure would
    // discard a perfectly readable error page.
    expect(isPluginHostToolFailure({ ok: false, status: 404, url: "https://x", text: "" })).toBe(
      false
    )
  })

  it("rejects non-objects and successes", () => {
    expect(isPluginHostToolFailure(null)).toBe(false)
    expect(isPluginHostToolFailure("error")).toBe(false)
    expect(isPluginHostToolFailure({ ok: true, results: [] })).toBe(false)
  })
})

describe("isPluginWebSearchSuccess", () => {
  it("requires ok plus a results array", () => {
    expect(
      isPluginWebSearchSuccess({
        ok: true,
        query: "q",
        provider: "tavily",
        answer: null,
        results: [],
      })
    ).toBe(true)
    expect(isPluginWebSearchSuccess({ ok: true, query: "q" })).toBe(false)
    expect(isPluginWebSearchSuccess({ ok: false, error: "no provider" })).toBe(false)
  })
})

describe("isPluginWebFetchSuccess", () => {
  it("recognizes a completed request even when the HTTP status failed", () => {
    expect(
      isPluginWebFetchSuccess({ ok: false, status: 500, url: "https://x", contentType: "" })
    ).toBe(true)
  })

  it("rejects a tool-level failure envelope", () => {
    expect(isPluginWebFetchSuccess({ ok: false, error: "blocked" })).toBe(false)
  })
})

describe("pluginWebFetchText", () => {
  const base: PluginWebFetchSuccess = {
    ok: true,
    status: 200,
    url: "https://x",
    contentType: "text/html",
  }

  it("prefers extracted text", () => {
    expect(pluginWebFetchText({ ...base, text: "extracted", body: "raw" })).toBe("extracted")
  })

  it("falls back to the raw body", () => {
    expect(pluginWebFetchText({ ...base, body: "raw" })).toBe("raw")
  })

  it("returns an empty string for a binary response", () => {
    expect(pluginWebFetchText({ ...base, binary: true, note: "PDF" })).toBe("")
  })
})

import type { PluginContext } from "@cognia/plugin-sdk"

import { buildEngineDeps } from "./runtime"

interface Recorded {
  invokeTool: jest.Mock
  chat: jest.Mock
  embed: jest.Mock
  warn: jest.Mock
}

function context(): { ctx: PluginContext; recorded: Recorded } {
  const recorded: Recorded = {
    invokeTool: jest.fn(async () => ({
      ok: true,
      query: "q",
      provider: "tavily",
      answer: null,
      results: [],
    })),
    chat: jest.fn(async function* () {
      yield { content: "hi" }
    }),
    embed: jest.fn(async () => [[0.1]]),
    warn: jest.fn(),
  }
  const ctx = {
    pluginId: "cognia-deep-research",
    agent: { invokeTool: recorded.invokeTool },
    ai: { chat: recorded.chat, embed: recorded.embed },
    logger: { info: jest.fn(), warn: recorded.warn },
  } as unknown as PluginContext
  return { ctx, recorded }
}

describe("buildEngineDeps", () => {
  it("assembles every dependency from the public context alone", () => {
    const { ctx } = context()
    const deps = buildEngineDeps(ctx)
    expect(typeof deps.search).toBe("function")
    expect(typeof deps.read).toBe("function")
    expect(typeof deps.ai.chat).toBe("function")
    expect(typeof deps.ai.embed).toBe("function")
  })

  it("routes model calls to the run's session", async () => {
    // On a multi-session host there is no ambient "current session"; without
    // this the call has no credentials at all.
    const { ctx, recorded } = context()
    const deps = buildEngineDeps(ctx, { sessionId: "s-9" })
    for await (const _ of deps.ai.chat([{ role: "user", content: "hi" }])) {
      // drain
    }
    await deps.ai.embed(["x"])
    expect(recorded.chat).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      expect.objectContaining({ sessionId: "s-9" })
    )
    expect(recorded.embed).toHaveBeenCalledWith(
      ["x"],
      expect.objectContaining({ sessionId: "s-9" })
    )
  })

  it("preserves the caller's model options while adding routing", async () => {
    const { ctx, recorded } = context()
    const deps = buildEngineDeps(ctx, { sessionId: "s-9" })
    for await (const _ of deps.ai.chat([{ role: "user", content: "hi" }], { temperature: 0.2 })) {
      // drain
    }
    expect(recorded.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ temperature: 0.2, sessionId: "s-9" })
    )
  })

  it("routes host tool calls to the same session and signal", async () => {
    const { ctx, recorded } = context()
    const controller = new AbortController()
    const deps = buildEngineDeps(ctx, { sessionId: "s-9", signal: controller.signal })
    await deps.search("cognia", 3)
    expect(recorded.invokeTool).toHaveBeenCalledWith(
      "web_search",
      { query: "cognia", maxResults: 3 },
      { sessionId: "s-9", signal: controller.signal }
    )
  })

  it("threads progress and cancellation into the engine deps", () => {
    const { ctx } = context()
    const reportProgress = jest.fn()
    const controller = new AbortController()
    const deps = buildEngineDeps(ctx, { reportProgress, signal: controller.signal })
    expect(deps.reportProgress).toBe(reportProgress)
    expect(deps.signal).toBe(controller.signal)
  })

  it("forwards engine warnings to the plugin logger", () => {
    const { ctx, recorded } = context()
    buildEngineDeps(ctx).logger?.warn("read failed", { url: "x" })
    expect(recorded.warn).toHaveBeenCalledWith("read failed", { url: "x" })
  })

  it("omits routing keys entirely when there is no session or signal", async () => {
    // An explicit `undefined` would still be an own property, and the host's
    // request schemas reject unexpected keys.
    const { ctx, recorded } = context()
    await buildEngineDeps(ctx).search("q", 1)
    expect(recorded.invokeTool).toHaveBeenCalledWith("web_search", expect.anything(), {})
  })
})

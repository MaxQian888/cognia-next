import type { PluginContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import { buildEngineDeps, getAiBridge } from "./runtime"

const ai: AiBridge = { chat: async function* () {}, embed: async () => [] }

function ctx(over: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    config: {},
    logger: { info() {}, warn() {} },
    ...over,
  } as unknown as PluginContext
}

describe("getAiBridge", () => {
  it("returns the bridge when chat + embed are functions", () => {
    expect(getAiBridge(ctx({ ai }))).toBe(ai)
  })
  it("returns null when ai is missing or malformed", () => {
    expect(getAiBridge(ctx())).toBeNull()
    expect(getAiBridge(ctx({ ai: { chat: 1, embed: 2 } }))).toBeNull()
  })
})

describe("buildEngineDeps", () => {
  it("errors NO_PROVIDER when there is no model bridge", async () => {
    const res = await buildEngineDeps(ctx())
    expect(res).toMatchObject({ ok: false, error: "NO_PROVIDER" })
  })

  it("errors MISSING_KEY when no api key is configured", async () => {
    const res = await buildEngineDeps(ctx({ ai }))
    expect(res).toMatchObject({ ok: false, error: "MISSING_KEY", provider: "exa" })
  })

  it("builds deps when ai + key are present", async () => {
    const res = await buildEngineDeps(
      ctx({ ai, config: { exaApiKey: "k" }, secrets: { get: async () => null } })
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deps.ai).toBe(ai)
      expect(typeof res.deps.search).toBe("function")
      expect(typeof res.deps.read).toBe("function")
    }
  })

  it("threads reportProgress + signal into the deps", async () => {
    const reportProgress = jest.fn()
    const signal = new AbortController().signal
    const res = await buildEngineDeps(ctx({ ai, config: { exaApiKey: "k" } }), {
      reportProgress,
      signal,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deps.reportProgress).toBe(reportProgress)
      expect(res.deps.signal).toBe(signal)
    }
  })
})

jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: jest.fn(),
}))
jest.mock("@/lib/db/eval-datasets", () => ({ getDataset: jest.fn(), listCases: jest.fn() }))
jest.mock("@/lib/db/eval-runs", () => ({ saveRun: jest.fn() }))
jest.mock("./targets/chat", () => ({
  createChatTarget: jest.fn(() => ({ label: "t", run: jest.fn() })),
  defaultChatTargetDeps: jest.fn(() => ({})),
}))

import type { AppSettings } from "@cognia/agent-config-types"
import { buildBrowserRunDeps, buildConfiguredRunDeps } from "./browser-deps"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

const settings = { defaultModel: "claude-sonnet-4-6" } as unknown as AppSettings

describe("buildBrowserRunDeps", () => {
  it("includes only deterministic scorers when no judge client resolves", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue(null)
    const { deps, deterministicOnly } = buildBrowserRunDeps({ appSettings: settings })
    expect(deterministicOnly).toBe(true)
    expect(deps.scorers.every((s) => s.requiresLlm === false)).toBe(true)
    expect(deps.newRunId()).toMatch(/^evrun_/)
    expect(typeof deps.now()).toBe("number")
  })

  it("adds the LLM scorers when a judge client resolves", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue({ complete: jest.fn() })
    const { deps, deterministicOnly } = buildBrowserRunDeps({ appSettings: settings })
    expect(deterministicOnly).toBe(false)
    expect(deps.scorers.some((s) => s.requiresLlm === true)).toBe(true)
  })

  it("forwards a cross-model judge override", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue({ complete: jest.fn() })
    buildBrowserRunDeps({ appSettings: settings, judgeModel: "claude-opus-4-8" })
    expect(buildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ modelOverride: "claude-opus-4-8" })
    )
  })

  it("prefers the session model and falls back to a default when nothing is set", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue(null)
    // session model wins
    buildBrowserRunDeps({
      appSettings: settings,
      session: { model: "session-model" } as never,
    })
    // null appSettings → hardcoded default, no throw
    expect(() => buildBrowserRunDeps({ appSettings: null })).not.toThrow()
  })
})

describe("buildConfiguredRunDeps", () => {
  it("uses only deterministic scorers when no judge client resolves", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue(null)
    const { deps, deterministicOnly } = buildConfiguredRunDeps({ appSettings: settings })
    expect(deterministicOnly).toBe(true)
    expect(deps.allScorers.length).toBeGreaterThan(0)
    expect(deps.allScorers.every((s) => s.requiresLlm === false)).toBe(true)
  })

  it("adds LLM scorers when a judge client resolves and builds a chat target from a spec", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue({ complete: jest.fn() })
    const { deps, deterministicOnly } = buildConfiguredRunDeps({ appSettings: settings })
    expect(deterministicOnly).toBe(false)
    expect(deps.allScorers.some((s) => s.requiresLlm === true)).toBe(true)
    const target = deps.buildTarget({ kind: "chat", label: "A", model: "m1" })
    expect(target.label).toBe("t") // from the mocked createChatTarget
    expect(deps.newRunId()).toMatch(/^evrun_/)
  })
})

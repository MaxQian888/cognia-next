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
import { buildConfiguredRunDeps } from "./browser-deps"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

const settings = { defaultModel: "claude-sonnet-4-6" } as unknown as AppSettings

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
    expect(typeof deps.now()).toBe("number")
  })

  it("forwards a cross-model judge override", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue({ complete: jest.fn() })
    buildConfiguredRunDeps({ appSettings: settings, judgeModel: "claude-opus-4-8" })
    expect(buildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ modelOverride: "claude-opus-4-8" })
    )
  })

  it("skips the judge client entirely when forceDeterministic is set", () => {
    ;(buildRendererLlmClient as jest.Mock).mockClear()
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue({ complete: jest.fn() })
    const { deterministicOnly } = buildConfiguredRunDeps({
      appSettings: settings,
      forceDeterministic: true,
    })
    expect(deterministicOnly).toBe(true)
    expect(buildRendererLlmClient).not.toHaveBeenCalled()
  })

  it("tolerates a null appSettings and passes the session through to the judge client", () => {
    ;(buildRendererLlmClient as jest.Mock).mockReturnValue(null)
    expect(() => buildConfiguredRunDeps({ appSettings: null })).not.toThrow()
    buildConfiguredRunDeps({
      appSettings: settings,
      session: { model: "session-model" } as never,
    })
    expect(buildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ model: "session-model" }) })
    )
  })
})

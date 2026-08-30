/** @jest-environment node */
const mockBuildAgentRole = jest.fn()
const mockBuildHeadless = jest.fn()

jest.mock("@/lib/ai/generation/agent-role-client", () => ({
  buildAgentRoleLlmClient: (...args: unknown[]) => mockBuildAgentRole(...args),
}))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({
  buildHeadlessTurnLlmClient: (...args: unknown[]) => mockBuildHeadless(...args),
}))

import { buildAgentBackedLlmClient } from "./agent-backed-client"

const ARGS = {
  session: { id: "s1", model: "sonnet" } as never,
  appSettings: { defaultProvider: "anthropic" } as never,
  featureId: "memory-project-mining",
  label: "Project context mining",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildAgentRole.mockResolvedValue(null)
  mockBuildHeadless.mockReturnValue(null)
})

describe("buildAgentBackedLlmClient", () => {
  it("prefers the configured Agent's own model when a key is available", async () => {
    const direct = { complete: jest.fn() }
    mockBuildAgentRole.mockResolvedValue(direct)
    await expect(buildAgentBackedLlmClient(ARGS)).resolves.toBe(direct)
    // A configured BYOK key must still get the cheap fast model rather than
    // paying for a whole agent turn.
    expect(mockBuildHeadless).not.toHaveBeenCalled()
  })

  it("defaults to the Agent's utility routing rather than its chat model", async () => {
    await buildAgentBackedLlmClient(ARGS)
    expect(mockBuildAgentRole).toHaveBeenCalledWith(expect.objectContaining({ role: "utility" }))
  })

  it("falls back to a headless turn when the renderer has no key", async () => {
    // This is the whole reason the module exists: on a Claude subscription the
    // bearer lives in the keyring, so the direct client is always null and a
    // feature that stopped there would be permanently inert.
    const fallback = { complete: jest.fn() }
    mockBuildHeadless.mockReturnValue(fallback)
    await expect(buildAgentBackedLlmClient(ARGS)).resolves.toBe(fallback)
    expect(mockBuildHeadless).toHaveBeenCalledWith({
      session: ARGS.session,
      label: "Project context mining",
    })
  })

  it("still falls back when Agent resolution throws", async () => {
    const fallback = { complete: jest.fn() }
    mockBuildAgentRole.mockRejectedValue(new Error("character row is gone"))
    mockBuildHeadless.mockReturnValue(fallback)
    await expect(buildAgentBackedLlmClient(ARGS)).resolves.toBe(fallback)
  })

  it("returns null when no transport can carry a turn at all", async () => {
    // Pure web with no paired companion: there is nothing to fall back TO, and
    // saying so is more honest than pretending a client exists.
    await expect(buildAgentBackedLlmClient(ARGS)).resolves.toBeNull()
  })

  it("forwards a feature's own model override to the direct leg", async () => {
    await buildAgentBackedLlmClient({ ...ARGS, override: { model: "haiku" } })
    expect(mockBuildAgentRole).toHaveBeenCalledWith(
      expect.objectContaining({ override: { model: "haiku" } })
    )
  })
})

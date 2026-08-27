jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: jest.fn(() => false) }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({
    model: "resolved-model",
    appendSystemPrompt: "resolver append",
    allowedTools: ["Bash", "Read"],
    mcpServers: { a2ui: {} },
  })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { defaultProvider: "anthropic" } }) },
}))

import { isTauri } from "@/lib/tauri"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { buildHeadlessTurnLlmClient, canRunHeadlessTurn } from "./headless-turn-llm-client"

const mockTauri = jest.mocked(isTauri)
const mockCompanion = jest.mocked(hasWebCompanionTarget)
const mockRun = jest.mocked(runAndCaptureAssistantReply)

beforeEach(() => {
  jest.clearAllMocks()
  mockTauri.mockReturnValue(true)
  mockCompanion.mockReturnValue(false)
  mockRun.mockResolvedValue({
    text: "rewritten draft",
    messageId: "m1",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  } as unknown as Awaited<ReturnType<typeof runAndCaptureAssistantReply>>)
})

describe("buildHeadlessTurnLlmClient", () => {
  it("has nothing to fall back to in a pure-web shell with no companion", () => {
    mockTauri.mockReturnValue(false)
    mockCompanion.mockReturnValue(false)
    expect(canRunHeadlessTurn()).toBe(false)
    expect(buildHeadlessTurnLlmClient({ session: null, label: "x" })).toBeNull()
  })

  it("builds a client whenever a transport exists", () => {
    mockTauri.mockReturnValue(false)
    mockCompanion.mockReturnValue(true)
    expect(buildHeadlessTurnLlmClient({ session: null, label: "x" })).not.toBeNull()
  })

  it("returns the captured reply text", async () => {
    const client = buildHeadlessTurnLlmClient({ session: null, label: "Prompt enhancement" })!
    await expect(client.complete("rewrite this")).resolves.toBe("rewritten draft")
  })

  it("clamps the turn to one toolless shot and lets the caller own the system prompt", async () => {
    const client = buildHeadlessTurnLlmClient({ session: null, label: "Prompt enhancement" })!
    await client.complete("rewrite this", { system: "You rewrite prompts." })

    const [, prompt, options] = mockRun.mock.calls[0]!
    expect(prompt).toBe("rewrite this")
    expect(options).toMatchObject({
      systemPrompt: "You rewrite prompts.",
      toolSurface: "none",
      allowedTools: [],
      mcpServers: {},
      maxTurns: 1,
    })
    // Mutually exclusive with `systemPrompt` — the resolver's append must not
    // ride along, or the SDK sees both.
    expect(options).not.toHaveProperty("appendSystemPrompt")
  })

  it("never runs the turn under the user's own session id", async () => {
    const session = { id: "real-session", model: "opus" } as never
    const client = buildHeadlessTurnLlmClient({ session, label: "Prompt enhancement" })!
    await client.complete("rewrite this")
    expect(mockRun.mock.calls[0]![0]).not.toBe("real-session")
  })
})

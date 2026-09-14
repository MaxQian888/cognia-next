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
import {
  buildHeadlessTurnLlmClient,
  canRunHeadlessTurn,
  deltasFromRunningTotal,
} from "./headless-turn-llm-client"

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

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const delta of iterable) out.push(delta)
  return out
}

describe("streaming a headless turn", () => {
  it("yields the reply as deltas of the capture's running total", async () => {
    mockRun.mockImplementation(async (_id, _prompt, _options, cap) => {
      await cap?.onPartial?.("Hel")
      await cap?.onPartial?.("Hello, wor")
      await cap?.onPartial?.("Hello, world")
      return { text: "Hello, world" } as never
    })
    const client = buildHeadlessTurnLlmClient({ session: null, label: "Selection" })!
    const deltas = await collect(client.stream!("say hi"))
    expect(deltas.join("")).toBe("Hello, world")
    expect(deltas.length).toBeGreaterThan(1)
  })

  it("forwards the caller's abort signal and system prompt to the same clamped turn", async () => {
    const controller = new AbortController()
    const client = buildHeadlessTurnLlmClient({ session: null, label: "Selection" })!
    await collect(
      client.stream!("explain", { system: "You explain.", abortSignal: controller.signal })
    )
    const [, , options, cap] = mockRun.mock.calls[0]!
    expect(options).toMatchObject({
      systemPrompt: "You explain.",
      toolSurface: "none",
      maxTurns: 1,
    })
    expect(cap).toMatchObject({ signal: controller.signal })
    expect(typeof cap?.onPartial).toBe("function")
  })

  it("does not hand the non-streaming call a partial callback", async () => {
    const client = buildHeadlessTurnLlmClient({ session: null, label: "Selection" })!
    await client.complete("rewrite this")
    expect(mockRun.mock.calls[0]![3]).not.toHaveProperty("onPartial")
  })
})

describe("deltasFromRunningTotal", () => {
  it("delivers the settled text when the capture never reported progress", async () => {
    await expect(collect(deltasFromRunningTotal(async () => "all at once"))).resolves.toEqual([
      "all at once",
    ])
  })

  // A chat middleware can rewrite the text mid-stream. A delta cannot retract
  // what was already yielded, so a total that does not extend it is skipped
  // rather than yielded as garbage.
  it("skips a total that is not an extension of what was already yielded", async () => {
    const deltas = await collect(
      deltasFromRunningTotal(async (onTotal) => {
        onTotal("draft one")
        onTotal("rewritten")
        onTotal("draft one, continued")
        return "draft one, continued"
      })
    )
    expect(deltas.join("")).toBe("draft one, continued")
  })

  it("rethrows the turn's failure after yielding what arrived", async () => {
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const delta of deltasFromRunningTotal(async (onTotal) => {
          onTotal("partial")
          await Promise.resolve()
          throw new Error("turn failed")
        })) {
          seen.push(delta)
        }
      })()
    ).rejects.toThrow("turn failed")
    expect(seen).toEqual(["partial"])
  })
})

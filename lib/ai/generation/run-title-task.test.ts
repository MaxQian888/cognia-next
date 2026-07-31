import {
  isPlaceholderTitle,
  shouldGenerateTitle,
  titlesEquivalent,
  runTitleTask,
} from "./run-title-task"
import { buildUtilityLlmClient } from "./utility-client"
import type { LlmClient } from "@/lib/twin/distill/llm"

jest.mock("./utility-client", () => ({
  buildUtilityLlmClient: jest.fn(),
}))

const mockBuild = buildUtilityLlmClient as jest.MockedFunction<typeof buildUtilityLlmClient>

function clientReturning(text: string): LlmClient {
  return { complete: jest.fn(async () => text) }
}

beforeEach(() => {
  mockBuild.mockReset()
})

describe("isPlaceholderTitle", () => {
  it("treats empty / undefined / known placeholders as auto-claimable", () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle("")).toBe(true)
    expect(isPlaceholderTitle("New chat")).toBe(true)
    expect(isPlaceholderTitle("New conversation")).toBe(true)
  })

  it("treats a real title as not a placeholder", () => {
    expect(isPlaceholderTitle("Refactor message list")).toBe(false)
  })
})

describe("shouldGenerateTitle", () => {
  it("requires enabled, first assistant turn, and auto title", () => {
    expect(shouldGenerateTitle({ titleEnabled: true, assistantCount: 1, titleAuto: true })).toBe(
      true
    )
    expect(
      shouldGenerateTitle({ titleEnabled: true, assistantCount: 1, titleAuto: undefined })
    ).toBe(true)
  })

  it("blocks when disabled, not first turn, or manually renamed", () => {
    expect(shouldGenerateTitle({ titleEnabled: false, assistantCount: 1, titleAuto: true })).toBe(
      false
    )
    expect(shouldGenerateTitle({ titleEnabled: true, assistantCount: 2, titleAuto: true })).toBe(
      false
    )
    expect(shouldGenerateTitle({ titleEnabled: true, assistantCount: 1, titleAuto: false })).toBe(
      false
    )
  })
})

describe("titlesEquivalent", () => {
  it("ignores case and surrounding/collapsed whitespace", () => {
    expect(titlesEquivalent("Fix the bug", "  fix   the bug ")).toBe(true)
    expect(titlesEquivalent("Fix the bug", "Fix the typo")).toBe(false)
  })
})

describe("runTitleTask", () => {
  const base = {
    session: null,
    appSettings: null,
    featureId: "test",
    sourceText: "help me refactor the message list",
    locale: "en",
  }

  it("generates and persists a title", async () => {
    mockBuild.mockReturnValue(clientReturning("Refactor message list"))
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, persist })
    expect(out).toBe("Refactor message list")
    expect(persist).toHaveBeenCalledWith("Refactor message list")
  })

  it("bails when the feature override is disabled", async () => {
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, override: { enabled: false }, persist })
    expect(out).toBeNull()
    expect(mockBuild).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it("bails when there is no source text", async () => {
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, sourceText: "   ", persist })
    expect(out).toBeNull()
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("returns null when no client can be resolved", async () => {
    mockBuild.mockReturnValue(null)
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, persist })
    expect(out).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it("returns null when the model yields an empty title", async () => {
    mockBuild.mockReturnValue(clientReturning("   "))
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, persist })
    expect(out).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it("skips persisting when the title is equivalent to the current one (smoothing)", async () => {
    mockBuild.mockReturnValue(clientReturning("refactor   message list"))
    const persist = jest.fn()
    const out = await runTitleTask({
      ...base,
      currentTitle: "Refactor message list",
      persist,
    })
    expect(out).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it("aborts when the row is no longer auto-managed", async () => {
    mockBuild.mockReturnValue(clientReturning("New title"))
    const persist = jest.fn()
    const out = await runTitleTask({
      ...base,
      isStillAuto: () => Promise.resolve(false),
      persist,
    })
    expect(out).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it("persists when isStillAuto resolves true", async () => {
    mockBuild.mockReturnValue(clientReturning("New title"))
    const persist = jest.fn()
    const out = await runTitleTask({ ...base, isStillAuto: () => true, persist })
    expect(out).toBe("New title")
    expect(persist).toHaveBeenCalledWith("New title")
  })

  it("swallows errors from persist and never throws", async () => {
    mockBuild.mockReturnValue(clientReturning("New title"))
    const persist = jest.fn(() => {
      throw new Error("boom")
    })
    const out = await runTitleTask({ ...base, persist })
    expect(out).toBeNull()
  })

  it("forwards the work kind to the generator", async () => {
    const client = clientReturning("Build the report")
    mockBuild.mockReturnValue(client)
    await runTitleTask({
      ...base,
      sourceText: "generate the weekly report",
      kind: "work",
      persist: jest.fn(),
    })
    const prompt = (client.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("Task:")
  })
})

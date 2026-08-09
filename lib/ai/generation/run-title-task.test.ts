import {
  isPlaceholderTitle,
  isInstantPreviewTitle,
  shouldGenerateTitle,
  titlesEquivalent,
  isTitleInFlight,
  runTitleTask,
} from "./run-title-task"
import { buildAgentRoleLlmClient } from "./agent-role-client"
import type { LlmClient } from "@/lib/twin/distill/llm"

const mockHasNoLeakingPiiDeep = jest.fn(() => true)

jest.mock("./agent-role-client", () => ({
  buildAgentRoleLlmClient: jest.fn(),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (...args: unknown[]) => mockHasNoLeakingPiiDeep(...args),
}))

const mockBuild = buildAgentRoleLlmClient as jest.MockedFunction<typeof buildAgentRoleLlmClient>

function clientReturning(text: string): LlmClient {
  return { complete: jest.fn(async () => text) }
}

beforeEach(() => {
  mockBuild.mockReset()
  mockHasNoLeakingPiiDeep.mockReset().mockReturnValue(true)
})

describe("isPlaceholderTitle", () => {
  it("treats empty / undefined / known placeholders as auto-claimable", () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle("")).toBe(true)
    expect(isPlaceholderTitle("New chat")).toBe(true)
    expect(isPlaceholderTitle("New conversation")).toBe(true)
  })

  it("recognizes i18n placeholder variants", () => {
    expect(isPlaceholderTitle("新对话")).toBe(true)
    expect(isPlaceholderTitle("新聊天")).toBe(true)
    expect(isPlaceholderTitle("新建会话")).toBe(true)
    expect(isPlaceholderTitle("新しい会話")).toBe(true)
    expect(isPlaceholderTitle("Nouvelle conversation")).toBe(true)
    expect(isPlaceholderTitle("Neue Unterhaltung")).toBe(true)
    expect(isPlaceholderTitle("Nueva conversación")).toBe(true)
  })

  it("treats a real title as not a placeholder", () => {
    expect(isPlaceholderTitle("Refactor message list")).toBe(false)
  })
})

describe("isInstantPreviewTitle", () => {
  it("detects a title that is a prefix of the first message", () => {
    expect(
      isInstantPreviewTitle(
        "help me refactor the message list comp",
        "help me refactor the message list component to use Zustand instead of context"
      )
    ).toBe(true)
  })

  it("detects a title ending with ellipsis (…)", () => {
    expect(
      isInstantPreviewTitle(
        "help me refactor the message list comp…",
        "help me refactor the message list component to use Zustand instead of context"
      )
    ).toBe(true)
  })

  it("detects a title ending with triple dots (...)", () => {
    expect(
      isInstantPreviewTitle(
        "help me refactor the message list...",
        "help me refactor the message list component to use Zustand"
      )
    ).toBe(true)
  })

  it("returns false for a real LLM-generated title", () => {
    expect(
      isInstantPreviewTitle(
        "Refactor message list",
        "help me refactor the message list component to use Zustand"
      )
    ).toBe(false)
  })

  it("returns false for empty inputs", () => {
    expect(isInstantPreviewTitle("", "some message")).toBe(false)
    expect(isInstantPreviewTitle("title", "")).toBe(false)
  })

  it("returns false for titles longer than 45 chars (not an instant preview)", () => {
    const longTitle = "a".repeat(46)
    expect(isInstantPreviewTitle(longTitle, "a".repeat(100))).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(
      isInstantPreviewTitle("Help Me Fix This", "help me fix this bug in the login flow")
    ).toBe(true)
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

  it("fails closed before client resolution when the title payload does not pass the PII gate", async () => {
    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    const persist = jest.fn()

    const out = await runTitleTask({ ...base, resultText: "private result", persist })

    expect(out).toBeNull()
    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith({
      sourceText: base.sourceText,
      resultText: "private result",
      locale: "en",
      kind: undefined,
    })
    expect(mockBuild).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
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

  it("dedupKey prevents concurrent calls for the same session", async () => {
    let resolveFirst: (v: string) => void = () => {}
    const slowClient: LlmClient = {
      complete: jest.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve
          })
      ),
    }
    mockBuild.mockReturnValue(slowClient)
    const persist = jest.fn()

    // Start first call (will hang on complete).
    const first = runTitleTask({ ...base, dedupKey: "s1", persist })
    // Second call with same key should bail immediately.
    const second = await runTitleTask({ ...base, dedupKey: "s1", persist })
    expect(second).toBeNull()
    expect(persist).not.toHaveBeenCalled()

    // Resolve the first — it should succeed.
    resolveFirst("Generated title")
    const firstResult = await first
    expect(firstResult).toBe("Generated title")
    expect(persist).toHaveBeenCalledWith("Generated title")
  })

  it("dedupKey is cleared after completion so sequential calls work", async () => {
    mockBuild.mockReturnValue(clientReturning("Title A"))
    const persist = jest.fn()

    await runTitleTask({ ...base, dedupKey: "s2", persist })
    expect(persist).toHaveBeenCalledWith("Title A")

    mockBuild.mockReturnValue(clientReturning("Title B"))
    await runTitleTask({ ...base, dedupKey: "s2", persist })
    expect(persist).toHaveBeenCalledWith("Title B")
  })

  it("dedupKey is cleared even on failure", async () => {
    mockBuild.mockReturnValue(null) // will cause null return
    const persist = jest.fn()

    await runTitleTask({ ...base, dedupKey: "s3", persist })
    expect(isTitleInFlight("s3")).toBe(false)
  })
})

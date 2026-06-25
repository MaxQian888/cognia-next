jest.mock("ai", () => ({
  __esModule: true,
  generateText: jest.fn(),
  streamText: jest.fn(),
}))

jest.mock("@cognia/provider-core/core/client", () => ({
  __esModule: true,
  getProviderModel: jest.fn(() => ({ model: "stub" })),
}))

import {
  ACTION_PROMPTS,
  buildActionUserPrompt,
  applyCanvasActionResult,
  getActionDescription,
  executeCanvasAction,
  executeCanvasActionStreaming,
  type CanvasActionType,
} from "./canvas-actions"
import { generateText, streamText } from "ai"

describe("ACTION_PROMPTS / getActionDescription", () => {
  it("includes prompts for every action type", () => {
    const types: CanvasActionType[] = [
      "custom",
      "review",
      "fix",
      "improve",
      "explain",
      "simplify",
      "expand",
      "translate",
      "format",
      "run",
    ]
    for (const t of types) {
      expect(ACTION_PROMPTS[t]).toBeTruthy()
      expect(getActionDescription(t)).toBeTruthy()
    }
  })
})

describe("buildActionUserPrompt", () => {
  it("includes language, target language, instruction, and selection", () => {
    const out = buildActionUserPrompt({
      actionType: "translate",
      content: "doc body",
      language: "english",
      targetLanguage: "fr",
      prompt: "polite tone",
      selection: "specific chunk",
    })
    expect(out).toContain("Language: english")
    expect(out).toContain("Target language: fr")
    expect(out).toContain("Instruction: polite tone")
    expect(out).toContain("Selection:\n\nspecific chunk")
    expect(out).not.toContain("Document:")
  })

  it("falls back to document when no selection", () => {
    const out = buildActionUserPrompt({ actionType: "review", content: "the doc" })
    expect(out).toContain("Document:\n\nthe doc")
  })
})

describe("applyCanvasActionResult", () => {
  it("returns the result when no selection is provided", () => {
    expect(applyCanvasActionResult("orig", "new")).toBe("new")
    expect(applyCanvasActionResult("orig", "new", "  ")).toBe("new")
  })

  it("substitutes the selection inline when found", () => {
    expect(applyCanvasActionResult("a [old] z", "[NEW]", "[old]")).toBe("a [NEW] z")
  })

  it("returns the result when the selection is not found", () => {
    expect(applyCanvasActionResult("hello world", "new", "missing")).toBe("new")
  })
})

describe("executeCanvasAction", () => {
  beforeEach(() => {
    ;(generateText as jest.Mock).mockReset()
  })

  it("returns success with text and explanation for non-content actions", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "this is a review" })
    const out = await executeCanvasAction("review", "code body", {
      provider: "anthropic",
      model: "x",
      apiKey: "k",
    })
    expect(out.success).toBe(true)
    expect(out.result).toBe("this is a review")
    expect(out.explanation).toBe("this is a review")
  })

  it("uses temperature 0.3 for fix/format actions", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "fixed" })
    await executeCanvasAction(
      "fix",
      "buggy code",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { language: "ts" }
    )
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.3 }))
  })

  it("returns success without explanation for content-replacement actions", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "improved" })
    const out = await executeCanvasAction("improve", "doc", {
      provider: "anthropic",
      model: "x",
      apiKey: "k",
    })
    expect(out.explanation).toBeUndefined()
  })

  it("returns failure when generateText throws an Error", async () => {
    ;(generateText as jest.Mock).mockRejectedValue(new Error("network"))
    const out = await executeCanvasAction("fix", "code", {
      provider: "anthropic",
      model: "x",
      apiKey: "k",
    })
    expect(out.success).toBe(false)
    expect(out.error).toBe("network")
  })

  it("falls back to 'Action failed' for non-Error throws", async () => {
    ;(generateText as jest.Mock).mockRejectedValue("oops")
    const out = await executeCanvasAction("fix", "code", {
      provider: "anthropic",
      model: "x",
      apiKey: "k",
    })
    expect(out.error).toBe("Action failed")
  })

  it("includes attachment context in the system prompt", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    await executeCanvasAction(
      "review",
      "code",
      { provider: "anthropic", model: "x", apiKey: "k" },
      {
        attachments: [
          {
            label: "ref",
            sourceType: "file",
            snapshot: "snippet",
            isMissing: false,
            isTruncated: true,
          },
        ] as never,
        prompt: "instruction",
      }
    )
    const call = (generateText as jest.Mock).mock.calls[0][0]
    expect(call.system).toContain("Attachment: ref [file] (truncated)")
    expect(call.system).toContain("User instruction:\ninstruction")
  })

  it("uses selection when provided", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    await executeCanvasAction(
      "improve",
      "full doc",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { selection: "selected chunk" }
    )
    const call = (generateText as jest.Mock).mock.calls[0][0]
    expect(call.prompt).toBe("selected chunk")
  })

  it("prepends Language: prefix for review/fix/improve/explain/format/run/custom", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    await executeCanvasAction(
      "review",
      "code",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { language: "ts" }
    )
    expect((generateText as jest.Mock).mock.calls[0][0].system).toContain("Language: ts")
  })

  it("prepends Target language: only for translate", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    await executeCanvasAction(
      "translate",
      "hello",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { targetLanguage: "fr" }
    )
    expect((generateText as jest.Mock).mock.calls[0][0].system).toContain("Target language: fr")
  })
})

describe("executeCanvasActionStreaming", () => {
  beforeEach(() => {
    ;(streamText as jest.Mock).mockReset()
  })

  it("emits tokens and completes with the full text", async () => {
    const tokens = ["He", "llo"]
    ;(streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        for (const t of tokens) yield t
      })(),
    })
    const onToken = jest.fn()
    const onComplete = jest.fn()
    const onError = jest.fn()
    await executeCanvasActionStreaming(
      "improve",
      "doc",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { onToken, onComplete, onError }
    )
    expect(onToken).toHaveBeenCalledTimes(2)
    expect(onComplete).toHaveBeenCalledWith("Hello")
    expect(onError).not.toHaveBeenCalled()
  })

  it("invokes onError on Error throws", async () => {
    ;(streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        throw new Error("boom")
      })(),
    })
    const onError = jest.fn()
    await executeCanvasActionStreaming(
      "fix",
      "code",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { onToken: () => {}, onComplete: () => {}, onError }
    )
    expect(onError).toHaveBeenCalledWith("boom")
  })

  it("invokes onError with fallback string on non-Error throws", async () => {
    ;(streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        throw "not-an-error"
      })(),
    })
    const onError = jest.fn()
    await executeCanvasActionStreaming(
      "fix",
      "code",
      { provider: "anthropic", model: "x", apiKey: "k" },
      { onToken: () => {}, onComplete: () => {}, onError }
    )
    expect(onError).toHaveBeenCalledWith("Streaming action failed")
  })
})

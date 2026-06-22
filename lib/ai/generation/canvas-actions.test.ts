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
  generateDiffPreview,
  buildCanvasReview,
  applyAcceptedCanvasReviewItems,
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

describe("generateDiffPreview", () => {
  it("returns unchanged for identical content", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb\nc")
    expect(diff.every((d) => d.type === "unchanged")).toBe(true)
  })

  it("identifies pure additions", () => {
    const diff = generateDiffPreview("a\nb", "a\nb\nc")
    expect(diff.find((d) => d.type === "added")?.content).toBe("c")
  })

  it("identifies pure removals", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb")
    expect(diff.find((d) => d.type === "removed")?.content).toBe("c")
  })

  it("recognises mid-stream additions via lookahead", () => {
    // a, b, c (orig) vs a, X, b, c (modified): X is an add, b/c stay unchanged
    const diff = generateDiffPreview("a\nb\nc", "a\nX\nb\nc")
    const added = diff.filter((d) => d.type === "added")
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe("X")
  })

  it("recognises mid-stream removals via lookahead", () => {
    const diff = generateDiffPreview("a\nX\nb\nc", "a\nb\nc")
    const removed = diff.filter((d) => d.type === "removed")
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe("X")
  })

  it("handles a replacement (no lookahead match) as remove+add", () => {
    const diff = generateDiffPreview("a\nold\nb", "a\nnew\nb")
    expect(diff.some((d) => d.type === "removed" && d.content === "old")).toBe(true)
    expect(diff.some((d) => d.type === "added" && d.content === "new")).toBe(true)
  })
})

describe("buildCanvasReview / applyAcceptedCanvasReviewItems", () => {
  it("groups added/removed lines into review items with proper change types", () => {
    const review = buildCanvasReview({
      requestId: "req-1",
      actionType: "improve",
      originalContent: "line1\nline2\nline3",
      proposedContent: "line1\nline2 modified\nline3\nextra",
    })
    expect(review.items.length).toBeGreaterThan(0)
    expect(["replace", "insert", "delete"]).toContain(review.items[0].changeType)
    expect(review.id).toMatch(/.+/)
    expect(review.requestId).toBe("req-1")
  })

  it("handles a pure-insert change type", () => {
    const review = buildCanvasReview({
      requestId: "req-2",
      actionType: "expand",
      originalContent: "a",
      proposedContent: "a\nb\nc",
    })
    const insert = review.items.find((i) => i.changeType === "insert")
    expect(insert).toBeDefined()
  })

  it("handles a pure-delete change type", () => {
    const review = buildCanvasReview({
      requestId: "req-3",
      actionType: "simplify",
      originalContent: "a\nb\nc",
      proposedContent: "a",
    })
    expect(review.items.some((i) => i.changeType === "delete")).toBe(true)
  })

  it("applyAcceptedCanvasReviewItems applies only accepted items in reverse order", () => {
    const review = buildCanvasReview({
      requestId: "r",
      actionType: "improve",
      originalContent: "alpha\nbeta\ngamma",
      proposedContent: "ALPHA\nbeta\ngamma",
    })
    review.items.forEach((item) => (item.status = "accepted"))
    const applied = applyAcceptedCanvasReviewItems("alpha\nbeta\ngamma", review.items)
    expect(applied).toContain("ALPHA")
  })

  it("applyAcceptedCanvasReviewItems leaves content untouched when no items are accepted", () => {
    const out = applyAcceptedCanvasReviewItems("orig", [])
    expect(out).toBe("orig")
  })

  it("applyAcceptedCanvasReviewItems handles inserts (deleteCount=0)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb", [
      {
        id: "x",
        actionType: "expand",
        changeType: "insert",
        originalText: "",
        proposedText: "INS",
        status: "accepted",
        range: { startLine: 2, endLine: 1 },
        diffLines: [],
      } as never,
    ])
    // start=2 maps to index 1; endLine<startLine → deleteCount=0; insert "INS" before "b"
    expect(out.split("\n")).toEqual(["a", "INS", "b"])
  })

  it("applyAcceptedCanvasReviewItems supports empty proposed text (pure deletion)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb\nc", [
      {
        id: "x",
        actionType: "simplify",
        changeType: "delete",
        originalText: "b",
        proposedText: "",
        status: "accepted",
        range: { startLine: 2, endLine: 2 },
        diffLines: [],
      } as never,
    ])
    expect(out.split("\n")).toEqual(["a", "c"])
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

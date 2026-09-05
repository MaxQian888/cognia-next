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
  buildCanvasActionPrompts,
  runCanvasAction,
  streamCanvasAction,
  CanvasActionPiiBlockedError,
  applyCanvasActionResult,
  getActionDescription,
  executeCanvasAction,
  executeCanvasActionStreaming,
  type CanvasActionType,
} from "./canvas-actions"
import { generateText, streamText } from "ai"
import { getProviderModel } from "@cognia/provider-core/core/client"

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

describe("buildCanvasActionPrompts", () => {
  // One builder for the hook and the plugin API. Previously the hook used a
  // second one that put the instruction in the user prompt and dropped
  // attachments entirely.
  it("carries language, instruction and attachments in the system prompt", () => {
    const { systemPrompt, userPrompt } = buildCanvasActionPrompts("improve", "doc body", {
      language: "typescript",
      prompt: "polite tone",
      attachments: [
        {
          id: "a1",
          sourceType: "artifact",
          sourceId: "art_1",
          label: "Spec",
          snapshot: "spec text",
        },
      ],
    })
    expect(systemPrompt).toContain("Language: typescript")
    expect(systemPrompt).toContain("User instruction:\npolite tone")
    expect(systemPrompt).toContain("Attachment: Spec [artifact]")
    expect(systemPrompt).toContain("spec text")
    expect(userPrompt).toBe("doc body")
  })

  it("sends the selection as the user prompt when there is one", () => {
    const { userPrompt } = buildCanvasActionPrompts("translate", "whole doc", {
      targetLanguage: "fr",
      selection: "specific chunk",
    })
    expect(userPrompt).toBe("specific chunk")
  })

  it("flags a missing or truncated attachment so the model knows", () => {
    const { systemPrompt } = buildCanvasActionPrompts("review", "doc", {
      attachments: [
        {
          id: "a1",
          sourceType: "session-message",
          sourceId: "m1",
          label: "Reply",
          snapshot: "partial",
          isTruncated: true,
        },
      ],
    })
    expect(systemPrompt).toContain("(truncated)")
  })
})

describe("the shared execution path", () => {
  const model = { model: "stub" } as never

  beforeEach(() => {
    ;(generateText as jest.Mock).mockReset()
    ;(streamText as jest.Mock).mockReset()
  })

  it("runCanvasAction refuses a prompt that would leak PII, before any dispatch", async () => {
    // The gate lives inside the executor rather than at each call site, which
    // is what makes it unskippable: the plugin path used to have no gate at all.
    await expect(runCanvasAction(model, "improve", "mail jane@example.com")).rejects.toBeInstanceOf(
      CanvasActionPiiBlockedError
    )
    expect(generateText).not.toHaveBeenCalled()
  })

  it("streamCanvasAction refuses the same prompt", async () => {
    await expect(
      streamCanvasAction(model, "improve", "mail jane@example.com", () => {})
    ).rejects.toBeInstanceOf(CanvasActionPiiBlockedError)
    expect(streamText).not.toHaveBeenCalled()
  })

  it("forwards the abort signal to the provider", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    const controller = new AbortController()
    await runCanvasAction(model, "improve", "doc", { abortSignal: controller.signal })
    expect((generateText as jest.Mock).mock.calls[0][0].abortSignal).toBe(controller.signal)
  })

  it("streamCanvasAction resolves with the full text it streamed", async () => {
    ;(streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        yield "He"
        yield "llo"
      })(),
    })
    const deltas: string[] = []
    const full = await streamCanvasAction(model, "improve", "doc", (d) => deltas.push(d))
    expect(deltas).toEqual(["He", "llo"])
    expect(full).toBe("Hello")
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

  it("forwards apiFlavor and headers to getProviderModel", async () => {
    ;(generateText as jest.Mock).mockResolvedValue({ text: "ok" })
    await executeCanvasAction("custom", "doc", {
      provider: "openai",
      model: "gpt-proxy",
      apiKey: "sk",
      baseURL: "https://gateway.example/v1",
      apiFlavor: "responses",
      headers: { "OpenAI-Beta": "responses=experimental" },
    })

    expect(getProviderModel).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-proxy",
      apiKey: "sk",
      baseURL: "https://gateway.example/v1",
      apiFlavor: "responses",
      headers: { "OpenAI-Beta": "responses=experimental" },
    })
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

  it("refuses a PII-bearing prompt through the plugin-facing wrapper too", async () => {
    // This wrapper is what `lib/plugin/api/canvas-api.ts` calls. It had no gate.
    const result = await executeCanvasAction("improve", "reach me at jane@example.com", {
      provider: "anthropic",
      model: "x",
      apiKey: "k",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("PII gate")
    expect(generateText).not.toHaveBeenCalled()
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

  it("forwards apiFlavor and headers to getProviderModel for streaming actions", async () => {
    ;(streamText as jest.Mock).mockReturnValue({
      textStream: (async function* () {
        yield "ok"
      })(),
    })

    await executeCanvasActionStreaming(
      "custom",
      "doc",
      {
        provider: "openai",
        model: "gpt-proxy",
        apiKey: "sk",
        baseURL: "https://gateway.example/v1",
        apiFlavor: "chat",
        headers: { "x-provider": "proxy" },
      },
      { onToken: () => {}, onComplete: () => {}, onError: () => {} }
    )

    expect(getProviderModel).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-proxy",
      apiKey: "sk",
      baseURL: "https://gateway.example/v1",
      apiFlavor: "chat",
      headers: { "x-provider": "proxy" },
    })
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

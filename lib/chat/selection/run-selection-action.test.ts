import type { LlmClient, LlmClientCallOptions } from "@/lib/twin/distill/llm"
import {
  EXPLAIN_SYSTEM_PROMPT,
  clampSelectionContext,
  promptLanguageName,
  runSelectionAction,
  translateSystemPrompt,
  type RunSelectionActionInput,
} from "./run-selection-action"

type Call = { prompt: string; options: LlmClientCallOptions | undefined }

function completeClient(reply: (prompt: string) => string): LlmClient & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    complete: jest.fn(async (prompt: string, options?: LlmClientCallOptions) => {
      calls.push({ prompt, options })
      return reply(prompt)
    }),
  }
}

function streamingClient(deltas: (prompt: string) => string[]): LlmClient & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    complete: jest.fn(async () => {
      throw new Error("the streaming path should be used")
    }),
    stream: (prompt: string, options?: LlmClientCallOptions) => {
      calls.push({ prompt, options })
      return (async function* () {
        for (const delta of deltas(prompt)) yield delta
      })()
    },
  }
}

const safe = () => true

function input(over: Partial<RunSelectionActionInput>): RunSelectionActionInput {
  return {
    action: "explain",
    text: "memoize the selector",
    language: "English",
    client: completeClient(() => "It caches the result."),
    isPiiSafe: safe,
    ...over,
  }
}

describe("explain", () => {
  it("explains the passage in the requested language, with the surrounding message as reference", async () => {
    const client = completeClient(() => "It caches the result.")
    const outcome = await runSelectionAction(
      input({
        client,
        language: "Simplified Chinese",
        context: "To stop re-renders, memoize the selector and pass it down.",
      })
    )
    expect(outcome).toEqual({ kind: "result", text: "It caches the result.", parts: 1 })
    const [call] = client.calls
    expect(call!.options?.system).toBe(EXPLAIN_SYSTEM_PROMPT)
    expect(call!.prompt).toContain("Surrounding message, for reference only")
    expect(call!.prompt).toContain("Passage to explain:\n\nmemoize the selector")
    expect(call!.prompt).toContain("Write the explanation in Simplified Chinese.")
  })

  it("streams the explanation as it grows", async () => {
    const seen: string[] = []
    const outcome = await runSelectionAction(
      input({
        client: streamingClient(() => ["It ", "caches ", "the result."]),
        onPartial: (text) => seen.push(text),
      })
    )
    // The last report is the settled, trimmed text.
    expect(seen).toEqual(["It ", "It caches ", "It caches the result.", "It caches the result."])
    expect(outcome).toMatchObject({ kind: "result", text: "It caches the result." })
  })

  it("numbers the parts of a passage too long for one call", async () => {
    const client = completeClient((prompt) =>
      prompt.includes("part 1 of 2") ? "First." : "Second."
    )
    const outcome = await runSelectionAction(
      input({ client, text: `${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`, chunkChars: 1_500 })
    )
    expect(outcome).toEqual({
      kind: "result",
      text: "**1/2**\n\nFirst.\n\n**2/2**\n\nSecond.",
      parts: 2,
    })
  })
})

describe("translate", () => {
  it("translates into the target language with a translation prompt", async () => {
    const client = completeClient(() => "Mémoïser le sélecteur")
    const outcome = await runSelectionAction(
      input({ action: "translate", language: "French", client })
    )
    expect(outcome).toMatchObject({ kind: "result", text: "Mémoïser le sélecteur" })
    expect(client.calls[0]!.options?.system).toBe(translateSystemPrompt("French"))
    expect(client.calls[0]!.prompt).toBe(
      "Passage to translate into French:\n\nmemoize the selector"
    )
  })

  // A translation is a context-free rendering; sending the message would only
  // invite the model to translate it too.
  it("sends no surrounding message", async () => {
    const client = completeClient(() => "x")
    await runSelectionAction(
      input({ action: "translate", client, context: "the whole message around it" })
    )
    expect(client.calls[0]!.prompt).not.toContain("the whole message around it")
  })

  it("continues a long translation as one text, part after part", async () => {
    const client = completeClient((prompt) => (prompt.includes("part 1 of 2") ? "Un." : "Deux."))
    const outcome = await runSelectionAction(
      input({
        action: "translate",
        client,
        text: `${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`,
        chunkChars: 1_500,
      })
    )
    expect(outcome).toEqual({ kind: "result", text: "Un.\n\nDeux.", parts: 2 })
  })
})

describe("summarize", () => {
  it("delegates to the material summarizer and reports its parts", async () => {
    const client = completeClient(() => "A summary.")
    const progress: unknown[] = []
    const outcome = await runSelectionAction(
      input({ action: "summarize", client, onProgress: (p) => progress.push(p) })
    )
    expect(outcome).toEqual({ kind: "result", text: "A summary.", parts: 1 })
    expect(progress).toContainEqual({ done: 1, total: 1, combining: false })
  })

  it("maps the combining pass onto progress", async () => {
    const client = completeClient(() => "part")
    const progress: { combining: boolean }[] = []
    await runSelectionAction(
      input({
        action: "summarize",
        client,
        text: `${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`,
        chunkChars: 1_500,
        onProgress: (p) => progress.push(p),
      })
    )
    expect(progress.some((p) => p.combining)).toBe(true)
  })
})

describe("outcomes that are not results", () => {
  it.each(["explain", "translate", "summarize"] as const)(
    "%s: refuses material that fails the PII gate before any call",
    async (action) => {
      const client = completeClient(() => "never")
      const outcome = await runSelectionAction(
        input({
          action,
          client,
          isPiiSafe: (text) => !text.includes("SECRET"),
          text: "a SECRET value",
        })
      )
      expect(outcome).toEqual({ kind: "unavailable", reason: "pii" })
      expect(client.complete).not.toHaveBeenCalled()
    }
  )

  it("gates the surrounding message an explanation would send", async () => {
    const client = completeClient(() => "never")
    const outcome = await runSelectionAction(
      input({
        client,
        context: "context with a SECRET",
        isPiiSafe: (text) => !text.includes("SECRET"),
      })
    )
    expect(outcome).toEqual({ kind: "unavailable", reason: "pii" })
    expect(client.complete).not.toHaveBeenCalled()
  })

  it.each(["explain", "translate", "summarize"] as const)(
    "%s: says no model can run here",
    async (action) => {
      await expect(runSelectionAction(input({ action, client: null }))).resolves.toEqual({
        kind: "unavailable",
        reason: "no-client",
      })
    }
  )

  it("says there is nothing to act on", async () => {
    await expect(runSelectionAction(input({ text: "  \n\n " }))).resolves.toEqual({
      kind: "unavailable",
      reason: "empty",
    })
  })

  it("says the model answered with nothing", async () => {
    await expect(
      runSelectionAction(input({ client: completeClient(() => "   ") }))
    ).resolves.toEqual({ kind: "unavailable", reason: "no-output" })
  })

  it("stops between parts once aborted", async () => {
    const controller = new AbortController()
    const client = completeClient(() => {
      controller.abort()
      return "first"
    })
    await expect(
      runSelectionAction(
        input({
          client,
          signal: controller.signal,
          text: `${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`,
          chunkChars: 1_500,
        })
      )
    ).rejects.toThrow()
    expect(client.complete).toHaveBeenCalledTimes(1)
  })
})

describe("clampSelectionContext", () => {
  it("returns short context whole", () => {
    expect(clampSelectionContext("  short  ", "short")).toBe("short")
  })

  it("centres a long context on the selection and marks both cuts", () => {
    const context = `${"x".repeat(5_000)}TARGET${"y".repeat(5_000)}`
    const out = clampSelectionContext(context, "TARGET", 100)
    expect(out).toContain("TARGET")
    expect(out.startsWith("…")).toBe(true)
    expect(out.endsWith("…")).toBe(true)
  })

  it("keeps the head when the selection cannot be found", () => {
    const out = clampSelectionContext("z".repeat(500), "missing", 100)
    expect(out.length).toBeLessThanOrEqual(102)
  })
})

describe("promptLanguageName", () => {
  it.each([
    ["zh-CN", "Simplified Chinese"],
    ["zh-TW", "Traditional Chinese"],
    ["fr", "French"],
    ["ja", "Japanese"],
    ["", "English"],
  ])("names %s as %s", (tag, name) => {
    expect(promptLanguageName(tag)).toBe(name)
  })

  it("returns a tag it cannot name as the tag", () => {
    expect(promptLanguageName("not a tag!")).toBe("not a tag!")
  })
})

import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  SELECTION_SUMMARY_SYSTEM_PROMPT,
  packSegments,
  summarizeMaterial,
} from "./summarize-material"
import { CONVERSATION_SUMMARY_SYSTEM_PROMPT } from "./summarizer"

jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: () => true }))

function client(replies: string[] | ((prompt: string) => string)): LlmClient & {
  complete: jest.Mock
} {
  let call = 0
  return {
    complete: jest.fn(async (prompt: string) =>
      typeof replies === "function" ? replies(prompt) : (replies[call++] ?? "")
    ),
  }
}

describe("packSegments", () => {
  it("packs whole segments until the next one would overflow", () => {
    expect(packSegments(["aaaa", "bbbb", "cccc"], 10)).toEqual(["aaaa\n\nbbbb", "cccc"])
  })

  it("splits only a segment that is larger than a chunk by itself", () => {
    const big = `${"x".repeat(8)}\n\n${"y".repeat(8)}`
    expect(packSegments([big], 10)).toEqual(["xxxxxxxx", "yyyyyyyy"])
  })

  it("skips blank segments and returns nothing for no material", () => {
    expect(packSegments(["  ", ""], 10)).toEqual([])
  })
})

describe("summarizeMaterial", () => {
  it("summarizes material that fits in one pass with the purpose's prompt", async () => {
    const llm = client(["the gist"])
    const out = await summarizeMaterial({ segments: ["a", "b"], purpose: "selection", client: llm })
    expect(out).toEqual({ kind: "summary", text: "the gist", chunks: 1 })
    expect(llm.complete.mock.calls[0][1].system).toBe(SELECTION_SUMMARY_SYSTEM_PROMPT)

    await summarizeMaterial({ segments: ["a"], purpose: "branch-seed", client: llm })
    expect(llm.complete.mock.calls[1][1].system).toBe(CONVERSATION_SUMMARY_SYSTEM_PROMPT)
  })

  // The old summarizer sliced at 24k and dropped the rest without a word.
  it("summarizes every chunk and combines them instead of dropping the tail", async () => {
    const llm = client((prompt) =>
      prompt.includes("Combine these partial summaries") ? "whole" : `part of ${prompt.slice(-4)}`
    )
    const progress: string[] = []
    const out = await summarizeMaterial({
      segments: ["seg1", "seg2", "seg3"],
      purpose: "selection",
      client: llm,
      chunkChars: 5,
      onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
    })
    expect(out).toEqual({ kind: "summary", text: "whole", chunks: 3 })
    expect(llm.complete).toHaveBeenCalledTimes(4)
    const combinePrompt = llm.complete.mock.calls[3][0] as string
    expect(combinePrompt).toContain("Part 1:")
    expect(combinePrompt).toContain("Part 3:")
    expect(progress).toEqual([
      "summarizing:0/4",
      "summarizing:1/4",
      "summarizing:2/4",
      "combining:3/4",
      "combining:4/4",
    ])
  })

  it("sends nothing when any chunk fails the PII gate", async () => {
    const llm = client(["never"])
    const out = await summarizeMaterial({
      segments: ["fine", "SECRET"],
      purpose: "selection",
      client: llm,
      chunkChars: 8,
      isPiiSafe: (text) => !text.includes("SECRET"),
    })
    expect(out).toEqual({ kind: "unavailable", reason: "pii" })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("reports why it could not summarize instead of inventing a digest", async () => {
    expect(
      await summarizeMaterial({ segments: ["  "], purpose: "selection", client: null })
    ).toEqual({
      kind: "unavailable",
      reason: "empty",
    })
    expect(
      await summarizeMaterial({ segments: ["a"], purpose: "selection", client: null })
    ).toEqual({
      kind: "unavailable",
      reason: "no-client",
    })
    expect(
      await summarizeMaterial({ segments: ["a"], purpose: "selection", client: client(["  "]) })
    ).toEqual({ kind: "unavailable", reason: "no-output" })
  })

  it("streams the final pass when the client can", async () => {
    const llm: LlmClient = {
      complete: jest.fn(),
      async *stream() {
        yield "one "
        yield "two"
      },
    }
    const partials: string[] = []
    const out = await summarizeMaterial({
      segments: ["a"],
      purpose: "selection",
      client: llm,
      onPartial: (text) => partials.push(text),
    })
    expect(out).toEqual({ kind: "summary", text: "one two", chunks: 1 })
    expect(partials).toEqual(["one ", "one two"])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it("stops between chunks once aborted and surfaces the abort", async () => {
    const controller = new AbortController()
    const llm = client(() => {
      controller.abort()
      return "partial"
    })
    await expect(
      summarizeMaterial({
        segments: ["seg1", "seg2"],
        purpose: "selection",
        client: llm,
        chunkChars: 5,
        signal: controller.signal,
      })
    ).rejects.toBeTruthy()
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })

  it("surfaces a provider error to the caller", async () => {
    const llm: LlmClient = { complete: jest.fn().mockRejectedValue(new Error("quota")) }
    await expect(
      summarizeMaterial({ segments: ["a"], purpose: "selection", client: llm })
    ).rejects.toThrow("quota")
  })
})

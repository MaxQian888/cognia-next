import { generateTurnLabel, MAX_LABEL_LENGTH, TURN_LABEL_PROMPT } from "./turn-label"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { SHORT_UTILITY_ANSWER_MAX_TOKENS } from "./title"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function mockClient(impl: (prompt: string) => Promise<string> | string): LlmClient {
  return { complete: jest.fn(async (p: string) => impl(p)) }
}

describe("generateTurnLabel", () => {
  it("returns empty when there is no user text", async () => {
    const client = mockClient(() => "Label")
    expect(await generateTurnLabel(client, { userText: "" })).toBe("")
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("sanitises and clamps the label", async () => {
    const client = mockClient(() => '"Refactor the whole message list rendering pipeline now"')
    const out = await generateTurnLabel(client, { userText: "do a big refactor" })
    expect(out.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
    expect(out.startsWith('"')).toBe(false)
  })

  it("passes the locale hint into the prompt", async () => {
    const client = mockClient(() => "x")
    await generateTurnLabel(client, { userText: "hi", locale: "zh-CN" })
    const prompt = (client.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("zh-CN")
  })

  it("returns empty when the client throws", async () => {
    const client: LlmClient = {
      complete: jest.fn(async () => {
        throw new Error("boom")
      }),
    }
    expect(await generateTurnLabel(client, { userText: "hi" })).toBe("")
  })

  it("leaves a reasoning model room to answer", async () => {
    const client = mockClient(() => "Trip plan")
    await generateTurnLabel(client, { userText: "plan a Kyoto trip" })
    const opts = (client.complete as jest.Mock).mock.calls[0][1] as { maxTokens: number }
    expect(opts.maxTokens).toBe(SHORT_UTILITY_ANSWER_MAX_TOKENS)
  })
})

describe("generateTurnLabel system prompt", () => {
  function systemOf(client: LlmClient): string | undefined {
    return ((client.complete as jest.Mock).mock.calls[0][1] as { system?: string }).system
  }

  it("sends the shipped prompt when nothing is published", async () => {
    const client = mockClient(() => "x")
    await generateTurnLabel(client, { userText: "hi" })
    expect(systemOf(client)).toBe(TURN_LABEL_PROMPT.defaultBody)
  })

  it("sends a session override only for that session", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: TURN_LABEL_PROMPT.id,
          scope: "session",
          targetId: "ses-1",
          revisionId: "por-turn-label-session",
          body: "Label the turn in three words.",
          contractVersion: TURN_LABEL_PROMPT.contractVersion,
        },
      ])
    )
    const inSession = mockClient(() => "x")
    await generateTurnLabel(inSession, { userText: "hi", promptContext: { sessionId: "ses-1" } })
    expect(systemOf(inSession)).toBe("Label the turn in three words.")

    const elsewhere = mockClient(() => "x")
    await generateTurnLabel(elsewhere, { userText: "hi", promptContext: { sessionId: "ses-2" } })
    expect(systemOf(elsewhere)).toBe(TURN_LABEL_PROMPT.defaultBody)
  })
})

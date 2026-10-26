import {
  suggestStarters,
  suggestFollowUps,
  DEFAULT_SUGGESTION_COUNT,
  FOLLOW_UP_SUGGESTIONS_PROMPT,
  MAX_SUGGESTION_LEN,
  STARTER_SUGGESTIONS_PROMPT,
} from "./suggestions"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import type { LlmClient } from "@/lib/twin/distill/llm"

function stubClient(reply: string | ((prompt: string) => string)): {
  client: LlmClient
  calls: { prompt: string; system?: string }[]
} {
  const calls: { prompt: string; system?: string }[] = []
  const client: LlmClient = {
    complete: async (prompt, options) => {
      calls.push({ prompt, system: options?.system })
      return typeof reply === "function" ? reply(prompt) : reply
    },
  }
  return { client, calls }
}

const safe = () => true
const unsafe = () => false

describe("suggestStarters", () => {
  it("parses a JSON array of starter prompts", async () => {
    const { client } = stubClient('["Explain this repo", "Write tests", "Find a bug"]')
    const res = await suggestStarters({}, { client, isPiiSafe: safe })
    expect(res).toEqual(["Explain this repo", "Write tests", "Find a bug"])
  })

  it("includes the persona when provided", async () => {
    const { client, calls } = stubClient("[]")
    await suggestStarters(
      { characterName: "Ada", characterDescription: "a math tutor" },
      { client, isPiiSafe: safe }
    )
    expect(calls[0].prompt).toContain("Ada — a math tutor")
  })

  it("falls back to a generic persona line when none provided", async () => {
    const { client, calls } = stubClient("[]")
    await suggestStarters({}, { client, isPiiSafe: safe })
    expect(calls[0].prompt).toMatch(/general-purpose/i)
  })

  it("returns [] without a model call when the persona fails the PII gate", async () => {
    const { client, calls } = stubClient("unused")
    const res = await suggestStarters(
      { characterDescription: "secret" },
      { client, isPiiSafe: unsafe }
    )
    expect(res).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("returns [] when the model throws", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("boom")
      },
    }
    expect(await suggestStarters({}, { client, isPiiSafe: safe })).toEqual([])
  })

  it("returns [] on non-JSON output", async () => {
    const { client } = stubClient("sorry, no ideas")
    expect(await suggestStarters({}, { client, isPiiSafe: safe })).toEqual([])
  })

  it("honours a custom count", async () => {
    const { client, calls } = stubClient('["a", "b", "c", "d", "e"]')
    const res = await suggestStarters({}, { client, isPiiSafe: safe, count: 2 })
    expect(res).toEqual(["a", "b"])
    expect(calls[0].prompt).toContain("Suggest 2 opening prompts")
  })

  it("requests the default count by default", async () => {
    const { client, calls } = stubClient("[]")
    await suggestStarters({}, { client, isPiiSafe: safe })
    expect(calls[0].prompt).toContain(`Suggest ${DEFAULT_SUGGESTION_COUNT} opening prompts`)
  })
})

describe("suggestFollowUps", () => {
  const messages = [
    { role: "user" as const, text: "how do I sort an array?" },
    { role: "assistant" as const, text: "Use Array.prototype.sort." },
  ]

  it("parses follow-up suggestions from the transcript", async () => {
    const { client, calls } = stubClient('["Sort descending?", "Sort objects by key?"]')
    const res = await suggestFollowUps({ recentMessages: messages }, { client, isPiiSafe: safe })
    expect(res).toEqual(["Sort descending?", "Sort objects by key?"])
    expect(calls[0].prompt).toContain("Assistant: Use Array.prototype.sort.")
  })

  it("preserves long reply outcomes and asks for the user's language or abstention", async () => {
    const { client, calls } = stubClient("[]")
    await suggestFollowUps(
      {
        recentMessages: [
          { role: "user", text: "验证构建" },
          { role: "assistant", text: "START" + "x".repeat(2000) + "最终结果：构建通过" },
        ],
      },
      { client, isPiiSafe: safe }
    )
    expect(calls[0].prompt).toContain("START")
    expect(calls[0].prompt).toContain("最终结果：构建通过")
    expect(calls[0].prompt.length).toBeLessThan(1000)
    expect(calls[0].system).toMatch(/language.*user/i)
    expect(calls[0].system).toContain("Return []")
  })

  it("returns [] when there are no usable messages", async () => {
    const { client, calls } = stubClient("unused")
    const res = await suggestFollowUps(
      { recentMessages: [{ role: "user", text: "  " }] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("returns [] without a model call when the transcript fails the PII gate", async () => {
    const { client, calls } = stubClient("unused")
    const res = await suggestFollowUps({ recentMessages: messages }, { client, isPiiSafe: unsafe })
    expect(res).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("drops blanks, duplicates, and over-long entries", async () => {
    const long = "x".repeat(MAX_SUGGESTION_LEN + 1)
    const { client } = stubClient(`["keep", "keep", "", "${long}", "also"]`)
    const res = await suggestFollowUps({ recentMessages: messages }, { client, isPiiSafe: safe })
    expect(res).toEqual(["keep", "also"])
  })

  it("returns [] when the model throws", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("boom")
      },
    }
    expect(
      await suggestFollowUps({ recentMessages: messages }, { client, isPiiSafe: safe })
    ).toEqual([])
  })

  it("can propagate generation failures so callers can distinguish retry from abstention", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("offline")
      },
    }
    await expect(
      suggestFollowUps(
        { recentMessages: messages },
        { client, isPiiSafe: safe, propagateErrors: true }
      )
    ).rejects.toThrow("offline")
  })

  it("uses the real PII gate when none is injected (benign transcript passes)", async () => {
    const { client } = stubClient('["a", "b"]')
    const res = await suggestFollowUps({ recentMessages: messages }, { client })
    expect(res).toEqual(["a", "b"])
  })
})

describe("default PII gate", () => {
  it("suggestStarters proceeds for a benign persona without an injected gate", async () => {
    const { client } = stubClient('["go"]')
    const res = await suggestStarters({ characterName: "Helper" }, { client })
    expect(res).toEqual(["go"])
  })
})

describe("customized suggestion prompts (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("uses the agent's starter override and the session's follow-up override", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob-1",
          promptId: STARTER_SUGGESTIONS_PROMPT.id,
          scope: "agent",
          targetId: "char-1",
          revisionId: "por-1",
          body: "Suggest data questions. Output a JSON array.",
          contractVersion: STARTER_SUGGESTIONS_PROMPT.contractVersion,
        },
        {
          bindingId: "pob-2",
          promptId: FOLLOW_UP_SUGGESTIONS_PROMPT.id,
          scope: "session",
          targetId: "s-1",
          revisionId: "por-2",
          body: "Suggest next steps as a JSON array.",
          contractVersion: FOLLOW_UP_SUGGESTIONS_PROMPT.contractVersion,
        },
      ])
    )
    const starter = stubClient('["a"]')
    await suggestStarters(
      {},
      { client: starter.client, isPiiSafe: safe, promptContext: { agentId: "char-1" } }
    )
    expect(starter.calls[0].system).toBe("Suggest data questions. Output a JSON array.")

    const followUp = stubClient('["b"]')
    await suggestFollowUps(
      { recentMessages: [{ role: "assistant", text: "done" }] },
      { client: followUp.client, isPiiSafe: safe, promptContext: { sessionId: "s-1" } }
    )
    expect(followUp.calls[0].system).toBe("Suggest next steps as a JSON array.")
  })

  it("falls back to the shipped text when an override drops the JSON contract", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: STARTER_SUGGESTIONS_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por",
          body: "Suggest a few prompts, one per line.",
          contractVersion: STARTER_SUGGESTIONS_PROMPT.contractVersion,
        },
      ])
    )
    const { client, calls } = stubClient('["a"]')
    await suggestStarters({}, { client, isPiiSafe: safe })
    expect(calls[0].system).toBe(STARTER_SUGGESTIONS_PROMPT.defaultBody)
  })
})

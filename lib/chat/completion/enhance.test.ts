import {
  enhancePrompt,
  ENHANCE_MODES,
  ENHANCE_STYLE_PROMPTS,
  ENHANCE_SYSTEM_PROMPT,
  DEFAULT_VARIANT_COUNT,
  MAX_ENHANCED_LEN,
  type EnhanceMode,
} from "./enhance"
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

describe("enhancePrompt", () => {
  it("rewrites a draft for each non-variants mode", async () => {
    for (const mode of ENHANCE_MODES.filter((m) => m !== "variants")) {
      const { client } = stubClient("Cleaned up version of the prompt.")
      const res = await enhancePrompt("make thing", mode as EnhanceMode, {
        client,
        isPiiSafe: safe,
      })
      expect(res).toEqual({ kind: "rewrite", text: "Cleaned up version of the prompt." })
    }
  })

  it("passes a system prompt and a style-specific instruction", async () => {
    const { client, calls } = stubClient("better")
    await enhancePrompt("draft", "technical", { client, isPiiSafe: safe })
    expect(calls[0].system).toMatch(/prompt-editing assistant/i)
    expect(calls[0].prompt).toMatch(/technical terminology/i)
    expect(calls[0].prompt).toContain("draft")
  })

  it("strips markdown fences and wrapping quotes from a rewrite", async () => {
    const { client } = stubClient('```\n"Quoted and fenced"\n```')
    const res = await enhancePrompt("x", "improve", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "rewrite", text: "Quoted and fenced" })
  })

  it("skips with reason 'empty' for blank drafts without calling the model", async () => {
    const { client, calls } = stubClient("unused")
    const res = await enhancePrompt("   ", "improve", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips with reason 'pii' when the draft fails the gate (no model call)", async () => {
    const { client, calls } = stubClient("unused")
    const res = await enhancePrompt("my key is sk-123", "improve", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })

  it("skips with 'no-output' when the rewrite is identical to the draft", async () => {
    const { client } = stubClient("same")
    const res = await enhancePrompt("same", "improve", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips with 'no-output' when the rewrite is empty after cleanup", async () => {
    const { client } = stubClient("```\n```")
    const res = await enhancePrompt("draft", "improve", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips with 'no-output' when the rewrite exceeds the length cap", async () => {
    const { client } = stubClient("x".repeat(MAX_ENHANCED_LEN + 1))
    const res = await enhancePrompt("draft", "improve", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  describe("variants mode", () => {
    it("parses a JSON array of variants", async () => {
      const { client, calls } = stubClient('["one", "two", "three"]')
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "variants", variants: ["one", "two", "three"] })
      expect(calls[0].prompt).toContain(`${DEFAULT_VARIANT_COUNT} alternative`)
    })

    it("tolerates prose around the JSON array", async () => {
      const { client } = stubClient('Here you go:\n["alpha", "beta"]\nHope that helps!')
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "variants", variants: ["alpha", "beta"] })
    })

    it("drops non-string entries, blanks, and exact-draft echoes", async () => {
      const { client } = stubClient('["draft", "", 42, "good one"]')
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "variants", variants: ["good one"] })
    })

    it("skips with 'no-output' when the model returns non-JSON", async () => {
      const { client } = stubClient("not json at all")
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "skipped", reason: "no-output" })
    })

    it("skips with 'no-output' when the JSON is not an array", async () => {
      const { client } = stubClient('{"not": "an array"}')
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "skipped", reason: "no-output" })
    })

    it("skips with 'no-output' when every variant is filtered out", async () => {
      const { client } = stubClient('["draft", ""]')
      const res = await enhancePrompt("draft", "variants", { client, isPiiSafe: safe })
      expect(res).toEqual({ kind: "skipped", reason: "no-output" })
    })
  })

  it("forwards the abort signal to the client", async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const client: LlmClient = {
      complete: async (_p, o) => {
        seen = o?.abortSignal
        return "ok rewrite"
      },
    }
    await enhancePrompt("draft", "improve", { client, isPiiSafe: safe, signal: ac.signal })
    expect(seen).toBe(ac.signal)
  })

  it("defaults to the real PII gate when none is injected", async () => {
    // The shared gate rejects an obvious credential, so this skips without a call.
    const { client, calls } = stubClient("unused")
    const res = await enhancePrompt(
      "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "improve",
      { client }
    )
    expect(res.kind).toBe("skipped")
    expect(calls).toHaveLength(0)
  })
})

describe("customized enhance prompts (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("sends the shipped system text and style line with no override", async () => {
    const { client, calls } = stubClient("Better.")
    await enhancePrompt("make it better", "concise", { client, isPiiSafe: safe })
    expect(calls[0].system).toBe(ENHANCE_SYSTEM_PROMPT.defaultBody)
    expect(calls[0].prompt).toContain(
      `Requested style: ${ENHANCE_STYLE_PROMPTS.concise.defaultBody}`
    )
  })

  it("applies a workspace style override to that mode only", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: ENHANCE_STYLE_PROMPTS.concise.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por",
          body: "At most two sentences.",
          contractVersion: ENHANCE_STYLE_PROMPTS.concise.contractVersion,
        },
      ])
    )
    const concise = stubClient("Better.")
    await enhancePrompt("make it better", "concise", {
      client: concise.client,
      isPiiSafe: safe,
      promptContext: { workspaceId: "ws-1" },
    })
    expect(concise.calls[0].prompt).toContain("Requested style: At most two sentences.")

    const detailed = stubClient("Better.")
    await enhancePrompt("make it better", "detailed", {
      client: detailed.client,
      isPiiSafe: safe,
      promptContext: { workspaceId: "ws-1" },
    })
    expect(detailed.calls[0].prompt).toContain(ENHANCE_STYLE_PROMPTS.detailed.defaultBody)
  })
})

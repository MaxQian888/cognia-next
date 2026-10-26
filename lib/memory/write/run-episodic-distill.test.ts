import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  EPISODIC_DISTILL_REQUEST_PROMPT,
  EPISODIC_DISTILL_SYSTEM_PROMPT,
  distillEpisodes,
  runEpisodicDistill,
  type RunEpisodicDistillDeps,
  type RunEpisodicDistillInput,
} from "./run-episodic-distill"

function client(reply: string | (() => Promise<string>)): LlmClient {
  return { complete: jest.fn(async () => (typeof reply === "string" ? reply : reply())) }
}

const transcript = [
  { role: "user", text: "Should we use Postgres or Mongo?" },
  { role: "assistant", text: "Postgres fits better." },
]

describe("distillEpisodes", () => {
  it("parses episodic candidates from JSON", async () => {
    const reply = JSON.stringify({
      episodes: [{ text: "Decided to use Postgres", importance: 7 }],
    })
    const out = await distillEpisodes(transcript, client(reply))
    expect(out).toEqual([{ type: "episodic", text: "Decided to use Postgres", importance: 7 }])
  })

  it("clamps importance and defaults it", async () => {
    const reply = JSON.stringify({
      episodes: [{ text: "a", importance: 50 }, { text: "b" }],
    })
    const out = await distillEpisodes(transcript, client(reply))
    expect(out.map((e) => e.importance)).toEqual([10, 5])
  })

  it("drops empty-text episodes", async () => {
    const reply = JSON.stringify({ episodes: [{ text: "  ", importance: 5 }] })
    expect(await distillEpisodes(transcript, client(reply))).toEqual([])
  })

  it("returns [] for empty transcript or bad JSON", async () => {
    expect(await distillEpisodes([], client("{}"))).toEqual([])
    expect(await distillEpisodes(transcript, client("nope"))).toEqual([])
  })

  it("sends the shipped system prompt and request around the transcript", async () => {
    const c = client(JSON.stringify({ episodes: [] }))
    await distillEpisodes(transcript, c)
    const [prompt, options] = (c.complete as jest.Mock).mock.calls[0]
    expect(options.system).toBe(EPISODIC_DISTILL_SYSTEM_PROMPT.defaultBody)
    expect(prompt).toBe(
      [
        "Conversation:\nuser: Should we use Postgres or Mongo?\nassistant: Postgres fits better.",
        "",
        'Distill 0–3 episodic memories. Skip anything trivial; return {"episodes":[]}',
        "if nothing notable. Each: a single self-contained sentence in the user's",
        "language, importance 1–10.",
        'Return JSON: {"episodes":[{"text","importance"}]}.',
      ].join("\n")
    )
  })

  describe("Prompt Center overrides", () => {
    afterEach(() => {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    })

    it("sends a published system and request override", async () => {
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot("test-db", [
          {
            bindingId: "pob-sys",
            promptId: EPISODIC_DISTILL_SYSTEM_PROMPT.id,
            scope: "account",
            targetId: "",
            revisionId: "por-episodic-system",
            body: "Distill episodes as JSON.",
            contractVersion: EPISODIC_DISTILL_SYSTEM_PROMPT.contractVersion,
          },
          {
            bindingId: "pob-req",
            promptId: EPISODIC_DISTILL_REQUEST_PROMPT.id,
            scope: "account",
            targetId: "",
            revisionId: "por-episodic-request",
            body: 'Transcript:\n{{conversation}}\nReply {"episodes":[{"text","importance"}]}',
            contractVersion: EPISODIC_DISTILL_REQUEST_PROMPT.contractVersion,
          },
        ])
      )
      const c = client(JSON.stringify({ episodes: [{ text: "Chose Postgres", importance: 6 }] }))
      const out = await distillEpisodes(transcript, c)
      const [prompt, options] = (c.complete as jest.Mock).mock.calls[0]
      expect(options.system).toBe("Distill episodes as JSON.")
      expect(prompt).toBe(
        'Transcript:\nuser: Should we use Postgres or Mongo?\nassistant: Postgres fits better.\nReply {"episodes":[{"text","importance"}]}'
      )
      expect(out).toEqual([{ type: "episodic", text: "Chose Postgres", importance: 6 }])
    })
  })
})

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

function input(over: Partial<RunEpisodicDistillInput> = {}): RunEpisodicDistillInput {
  return { transcript, scope: "global", provenance: "user", config: cfg(), ...over }
}

function deps(over: Partial<RunEpisodicDistillDeps> = {}): RunEpisodicDistillDeps {
  return {
    distill: jest.fn(async (): Promise<MemoryCandidate[]> => [
      { type: "episodic", text: "Decided to use Postgres", importance: 7 },
    ]),
    consolidate: jest.fn(async () => ({ applied: [{ op: "ADD" } as never] })),
    ...over,
  }
}

describe("runEpisodicDistill", () => {
  it("distills + consolidates a finished session", async () => {
    const d = deps()
    const res = await runEpisodicDistill(input(), d)
    expect(d.distill).toHaveBeenCalled()
    expect(d.consolidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: "user", scope: "global" })
    )
    expect(res.applied).toHaveLength(1)
  })

  it("redacts the transcript before sending it to the distiller", async () => {
    const distill = jest.fn(async (): Promise<MemoryCandidate[]> => [])
    const d = deps({
      distill,
      redact: jest.fn((text) => text.replace("sk-ant-secret", "[REDACTED]")),
    })

    await runEpisodicDistill(
      input({ transcript: [{ role: "user", text: "token sk-ant-secret" }] }),
      d
    )

    expect(distill).toHaveBeenCalledWith([{ role: "user", text: "token [REDACTED]" }])
  })

  it("skips when disabled / learning off / temporary", async () => {
    for (const c of [{ enabled: false }, { learnFromChats: false }, { temporary: true }]) {
      const d = deps()
      await runEpisodicDistill(input({ config: cfg(c) }), d)
      expect(d.distill).not.toHaveBeenCalled()
    }
  })

  it("skips connector-inbound sessions", async () => {
    const d = deps()
    await runEpisodicDistill(input({ provenance: "inbound" }), d)
    expect(d.distill).not.toHaveBeenCalled()
  })

  it("skips empty transcripts", async () => {
    const d = deps()
    await runEpisodicDistill(input({ transcript: [] }), d)
    expect(d.distill).not.toHaveBeenCalled()
  })

  it("returns empty when nothing notable is distilled", async () => {
    const d = deps({ distill: jest.fn(async () => []) })
    const res = await runEpisodicDistill(input(), d)
    expect(d.consolidate).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("drops PII-leaking episodes", async () => {
    const d = deps({
      distill: jest.fn(async (): Promise<MemoryCandidate[]> => [
        { type: "episodic", text: "shared key sk-ant-api03-AAAABBBBCCCCDDDD", importance: 6 },
      ]),
    })
    const res = await runEpisodicDistill(input(), d)
    expect(d.consolidate).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("swallows errors", async () => {
    const d = deps({
      distill: jest.fn(async () => {
        throw new Error("boom")
      }),
    })
    expect((await runEpisodicDistill(input(), d)).applied).toEqual([])
  })
})

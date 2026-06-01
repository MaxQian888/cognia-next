import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
import {
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
})

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

function input(over: Partial<RunEpisodicDistillInput> = {}): RunEpisodicDistillInput {
  return { transcript, scope: "global", provenance: "user", config: cfg(), ...over }
}

function deps(over: Partial<RunEpisodicDistillDeps> = {}): RunEpisodicDistillDeps {
  return {
    distill: jest.fn(
      async (): Promise<MemoryCandidate[]> => [
        { type: "episodic", text: "Decided to use Postgres", importance: 7 },
      ]
    ),
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

  it("skips when disabled / autoExtract off / temporary", async () => {
    for (const c of [{ enabled: false }, { autoExtract: false }, { temporary: true }]) {
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
      distill: jest.fn(
        async (): Promise<MemoryCandidate[]> => [
          { type: "episodic", text: "shared key sk-ant-api03-AAAABBBBCCCCDDDD", importance: 6 },
        ]
      ),
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

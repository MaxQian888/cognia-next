import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"
import type { MemoryCandidate } from "@/lib/memory/extract/extractor"
import {
  runMemoryExtraction,
  sessionProvenance,
  type RunMemoryExtractionDeps,
  type RunMemoryExtractionInput,
} from "./run-memory-extraction"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

const salientPair = { userText: "I always use pnpm", assistantText: "Noted." }

function input(over: Partial<RunMemoryExtractionInput> = {}): RunMemoryExtractionInput {
  return {
    newPair: salientPair,
    scope: "global",
    provenance: "user",
    config: cfg(),
    ...over,
  }
}

function deps(over: Partial<RunMemoryExtractionDeps> = {}): RunMemoryExtractionDeps & {
  extractCalls: number
  consolidateInputs: unknown[]
} {
  const consolidateInputs: unknown[] = []
  const wrapper = {
    extractCalls: 0,
    consolidateInputs,
    extract: jest.fn(async (): Promise<MemoryCandidate[]> => {
      wrapper.extractCalls += 1
      return [{ type: "semantic", text: "The user uses pnpm", importance: 6 }]
    }),
    consolidate: jest.fn(async (ci): Promise<{ applied: ConsolidationOp[] }> => {
      consolidateInputs.push(ci)
      return { applied: [{ op: "NOOP" }] }
    }),
    ...over,
  }
  return wrapper as RunMemoryExtractionDeps & { extractCalls: number; consolidateInputs: unknown[] }
}

describe("runMemoryExtraction", () => {
  it("runs the full pipeline for a salient user turn", async () => {
    const d = deps()
    const res = await runMemoryExtraction(input(), d)
    expect(d.extract).toHaveBeenCalled()
    expect(d.consolidate).toHaveBeenCalled()
    expect(res.applied).toEqual([{ op: "NOOP" }])
  })

  it("redacts PII from the extraction inputs before the LLM call", async () => {
    let seen: { userText: string; assistantText: string } | undefined
    const d = deps({
      extract: jest.fn(async (eInput) => {
        seen = eInput.newPair
        return []
      }),
    })
    await runMemoryExtraction(
      input({
        newPair: {
          userText: "I always use pnpm; reach me at dev@example.com",
          assistantText: "Noted.",
        },
      }),
      d
    )
    expect(seen?.userText).not.toContain("dev@example.com")
    expect(seen?.userText).toContain("<EMAIL_")
    // Non-PII content survives so the fact still extracts.
    expect(seen?.userText).toContain("pnpm")
  })

  it("honors an injected redact dependency", async () => {
    let seen: string | undefined
    const d = deps({
      redact: (t) => t.replace(/secret/g, "[X]"),
      extract: jest.fn(async (eInput) => {
        seen = eInput.newPair.userText
        return []
      }),
    })
    await runMemoryExtraction(
      input({ newPair: { userText: "I always use pnpm with a secret", assistantText: "ok" } }),
      d
    )
    expect(seen).toBe("I always use pnpm with a [X]")
  })

  it("fails closed before extraction when redaction leaves PII in the payload", async () => {
    const d = deps({
      redact: (text) => text,
      isPayloadPiiSafe: () => false,
    })
    const result = await runMemoryExtraction(input(), d)
    expect(d.extract).not.toHaveBeenCalled()
    expect(result.applied).toEqual([])
  })

  it("allows procedural for user provenance, not for inbound", async () => {
    const d = deps()
    await runMemoryExtraction(input({ provenance: "user" }), d)
    const ci = d.consolidateInputs[0] as { provenance: string }
    expect(ci.provenance).toBe("user")
    const allow = (d.extract as jest.Mock).mock.calls[0][0].allowTypes
    expect(allow).toEqual(["semantic", "procedural"])
  })

  it("skips entirely for connector-inbound provenance", async () => {
    const d = deps()
    const res = await runMemoryExtraction(input({ provenance: "inbound" }), d)
    expect(d.extract).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("skips when disabled / autoExtract off / temporary", async () => {
    for (const c of [{ enabled: false }, { autoExtract: false }, { temporary: true }]) {
      const d = deps()
      const res = await runMemoryExtraction(input({ config: cfg(c) }), d)
      expect(d.extract).not.toHaveBeenCalled()
      expect(res.applied).toEqual([])
    }
  })

  it("skips when the turn is not salient (no LLM call)", async () => {
    const d = deps()
    const res = await runMemoryExtraction(
      input({ newPair: { userText: "ok thanks", assistantText: "yw" } }),
      d
    )
    expect(d.extract).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("returns empty when extraction yields no candidates", async () => {
    const d = deps({ extract: jest.fn(async () => []) })
    const res = await runMemoryExtraction(input(), d)
    expect(d.consolidate).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("drops PII-leaking candidates before consolidation", async () => {
    const d = deps({
      extract: jest.fn(async (): Promise<MemoryCandidate[]> => [
        { type: "semantic", text: "email me at bob@example.com", importance: 5 },
      ]),
    })
    const res = await runMemoryExtraction(input(), d)
    expect(d.consolidate).not.toHaveBeenCalled()
    expect(res.applied).toEqual([])
  })

  it("honors a custom isPiiSafe gate", async () => {
    const d = deps({ isPiiSafe: () => false })
    const res = await runMemoryExtraction(input(), d)
    expect(res.applied).toEqual([])
  })

  it("swallows errors and returns empty", async () => {
    const d = deps({
      extract: jest.fn(async () => {
        throw new Error("LLM down")
      }),
    })
    const res = await runMemoryExtraction(input(), d)
    expect(res.applied).toEqual([])
  })
})

describe("sessionProvenance", () => {
  it("marks connector-bound sessions inbound, plain sessions user", () => {
    expect(sessionProvenance(null)).toBe("user")
    expect(sessionProvenance({ platformBinding: undefined } as never)).toBe("user")
    expect(sessionProvenance({ platformBinding: { platform: "lark" } } as never)).toBe("inbound")
  })
})

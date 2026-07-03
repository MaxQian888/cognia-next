import type { LlmClient } from "@/lib/twin/distill/llm"
import { deterministicScorers, llmScorers } from "./index"
import {
  SCORER_CATALOG,
  ALL_SCORER_IDS,
  DETERMINISTIC_SCORER_IDS,
  SCORER_DIMENSIONS,
  scorersForDimension,
  sanitizeScorerIds,
} from "./catalog"

// The judge / RAG factories only need a client to *construct*; scoring is never
// invoked here, so a no-op complete() is enough.
const fakeClient: LlmClient = {
  complete: async () => "{}",
}

describe("SCORER_CATALOG", () => {
  it("matches the real scorer factory output exactly (id + dimension + requiresLlm)", () => {
    const real = [...deterministicScorers(), ...llmScorers({ client: fakeClient })].map((s) => ({
      id: s.id,
      dimension: s.dimension,
      requiresLlm: s.requiresLlm,
    }))
    // Same set, ordering-independent — the catalog documents report order but
    // the guard only needs id/dimension/requiresLlm parity.
    const sortById = <T extends { id: string }>(xs: T[]) =>
      [...xs].sort((a, b) => a.id.localeCompare(b.id))
    expect(sortById([...SCORER_CATALOG])).toEqual(sortById(real))
  })

  it("has unique ids", () => {
    expect(new Set(ALL_SCORER_IDS).size).toBe(ALL_SCORER_IDS.length)
  })

  it("splits deterministic vs llm ids by requiresLlm", () => {
    expect(DETERMINISTIC_SCORER_IDS).toEqual(
      SCORER_CATALOG.filter((s) => !s.requiresLlm).map((s) => s.id)
    )
    expect(DETERMINISTIC_SCORER_IDS).toContain("tool-redundancy")
    // The old drift bug: `redundancy` was never a real scorer id.
    expect(ALL_SCORER_IDS).not.toContain("redundancy")
  })

  it("enumerates each dimension once, in catalog order", () => {
    expect(SCORER_DIMENSIONS).toEqual(["tool-use", "response-quality", "cost", "rag"])
  })

  it("groups scorers by dimension preserving order", () => {
    const toolUse = scorersForDimension("tool-use").map((s) => s.id)
    expect(toolUse).toEqual([
      "tool-selection",
      "tool-args",
      "tool-order",
      "tool-redundancy",
      "trajectory-unordered",
    ])
    expect(scorersForDimension("cost").map((s) => s.id)).toEqual(["cost"])
  })

  it("sanitizeScorerIds drops unknown ids and keeps known ones", () => {
    expect(sanitizeScorerIds(["cost", "redundancy", "judge-task-completion"])).toEqual([
      "cost",
      "judge-task-completion",
    ])
    expect(sanitizeScorerIds([])).toEqual([])
  })
})

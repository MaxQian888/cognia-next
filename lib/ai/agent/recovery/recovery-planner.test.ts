import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

import { planRecovery, type RecoveryCandidate } from "./recovery-planner"

function turns(texts: string[]): CanonicalTurn[] {
  return texts.map((text, i) => ({
    turnId: `t${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text,
  }))
}

function candidate(overrides: Partial<RecoveryCandidate>): RecoveryCandidate {
  return {
    id: "c1",
    kind: "canonical-log",
    fidelity: "structured",
    turns: turns(["a", "b"]),
    ...overrides,
  }
}

describe("planRecovery", () => {
  it("no candidates ⇒ recovery_required", () => {
    expect(planRecovery([])).toEqual({
      action: "recovery_required",
      reason: "no-candidates",
      detail: [],
    })
  })

  it("a strictly dominant candidate (superset coverage, >= fidelity) auto-recovers", () => {
    const longer = candidate({ id: "log", turns: turns(["a", "b", "c"]) })
    const shorter = candidate({ id: "checkpoint", kind: "checkpoint", turns: turns(["a", "b"]) })
    expect(planRecovery([longer, shorter])).toEqual({ action: "auto", candidateId: "log" })
  })

  it("a fork in the shared prefix ALWAYS pauses — no side is 'better'", () => {
    const a = candidate({ id: "a", turns: turns(["a", "b"]) })
    const b = candidate({ id: "b", turns: turns(["a", "DIFFERENT"]) })
    const plan = planRecovery([a, b])
    expect(plan).toMatchObject({ action: "recovery_required", reason: "forked-history" })
    expect((plan as { detail: string[] }).detail).toEqual(["a <> b"])
  })

  it("longer-but-lower-fidelity vs shorter-but-higher-fidelity has NO dominant ⇒ pause", () => {
    const long = candidate({ id: "long", fidelity: "summary-only", turns: turns(["a", "b", "c"]) })
    const short = candidate({ id: "short", fidelity: "native-exact", turns: turns(["a", "b"]) })
    const plan = planRecovery([long, short])
    expect(plan).toMatchObject({ action: "recovery_required", reason: "no-dominant" })
    expect((plan as { detail: string[] }).detail).toEqual(expect.arrayContaining(["long", "short"]))
  })

  it("identical candidates collapse deterministically (lexicographic id)", () => {
    const a = candidate({ id: "zzz" })
    const b = candidate({ id: "aaa", kind: "import" })
    expect(planRecovery([a, b])).toEqual({ action: "auto", candidateId: "aaa" })
  })

  it("ambiguous side effects on the chosen candidate force recovery_required", () => {
    const chosen = candidate({
      id: "log",
      turns: turns(["a", "b", "c"]),
      hasAmbiguousSideEffects: true,
    })
    const other = candidate({ id: "checkpoint", turns: turns(["a"]) })
    expect(planRecovery([chosen, other])).toEqual({
      action: "recovery_required",
      reason: "ambiguous-side-effects",
      detail: ["log"],
    })
  })

  it("RecoveryCandidate has no modification-time field (no last-modified-wins, structurally)", () => {
    const keys = Object.keys(candidate({}))
    expect(keys).not.toEqual(expect.arrayContaining(["mtime"]))
    expect(keys).not.toEqual(expect.arrayContaining(["lastModified"]))
    expect(keys).not.toEqual(expect.arrayContaining(["updatedAt"]))
  })
})

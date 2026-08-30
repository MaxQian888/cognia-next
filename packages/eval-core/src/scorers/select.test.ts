import { selectScorers } from "./select"
import type { Scorer } from "../domain/eval"

const scorer = (id: string): Scorer => ({
  id,
  dimension: "tool-use",
  requiresLlm: false,
  gating: true,
  score: () => ({
    scorerId: id,
    dimension: "tool-use" as const,
    status: "scored" as const,
    value: 1,
    passed: true,
  }),
})
const all = [scorer("a"), scorer("b"), scorer("c")]

describe("selectScorers", () => {
  it("returns all scorers when the id list is empty", () => {
    expect(selectScorers(all, []).map((s) => s.id)).toEqual(["a", "b", "c"])
  })

  it("filters by id, preserving the source order (not the id-list order)", () => {
    expect(selectScorers(all, ["c", "a"]).map((s) => s.id)).toEqual(["a", "c"])
  })

  it("ignores unknown ids", () => {
    expect(selectScorers(all, ["a", "zzz"]).map((s) => s.id)).toEqual(["a"])
  })
})

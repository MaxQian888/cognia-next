import { mergeBlockReason } from "../merge"
import {
  FORGE_CI_STATES,
  FORGE_MERGE_METHODS,
  FORGE_REVIEW_STATES,
  type ForgeObservation,
} from "./types"

/**
 * A union that silently loses a member does not fail to compile — every
 * `switch` over it just stops handling the case, and the merge gate starts
 * answering the wrong question. These pin the memberships the gate depends on.
 */
describe("forge state unions", () => {
  it("keeps 'no checks' and 'could not read the checks' as separate CI states", () => {
    expect(FORGE_CI_STATES).toContain("none")
    expect(FORGE_CI_STATES).toContain("unknown")
    // And the gate must keep treating them as opposites.
    const base: ForgeObservation = {
      ci: "none",
      review: "none",
      mergeable: true,
      conflict: false,
      merged: false,
    }
    expect(mergeBlockReason(base)).toBeNull()
    expect(mergeBlockReason({ ...base, ci: "unknown" })).toBe("ciUnknown")
  })

  it("keeps a review decision, not a boolean", () => {
    // "nobody reviewed and nobody needs to" and "a review is required" are
    // different answers; a boolean collapses them and blocks every repository
    // that does not require review.
    expect([...FORGE_REVIEW_STATES].sort()).toEqual([
      "approved",
      "changesRequested",
      "none",
      "reviewRequired",
    ])
  })

  it("covers every merge method a forge offers", () => {
    expect([...FORGE_MERGE_METHODS].sort()).toEqual(["merge", "rebase", "squash"])
  })

  it("has a decision for every CI state, so none falls through the gate", () => {
    const seen = FORGE_CI_STATES.map((ci) =>
      mergeBlockReason({ ci, review: "none", mergeable: true, conflict: false, merged: false })
    )
    // Exactly the two clean states pass; the other three each name a reason.
    expect(seen.filter((reason) => reason === null)).toHaveLength(2)
    expect(seen.filter(Boolean)).toEqual(["ciUnknown", "ciPending", "ciFailing"])
  })

  it("has a decision for every review state", () => {
    const seen = FORGE_REVIEW_STATES.map((review) =>
      mergeBlockReason({ ci: "passing", review, mergeable: true, conflict: false, merged: false })
    )
    expect(seen).toEqual([null, "changesRequested", "reviewRequired", null])
  })
})

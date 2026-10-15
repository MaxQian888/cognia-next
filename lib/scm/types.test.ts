import {
  ACTIVE_INTEGRATION_STATES,
  TERMINAL_CHANGESET_STATES,
  composedItems,
  type IntegrationItem,
} from "./types"

const item = (changesetId: string, outcome: IntegrationItem["outcome"]): IntegrationItem => ({
  changesetId,
  headSha: "h",
  outcome,
  conflictFiles: [],
  commitSha: null,
})

describe("scm types", () => {
  it("counts merged and rerere-resolved items as composed, in order", () => {
    expect(
      composedItems({
        items: [
          item("a", "merged"),
          item("b", "conflicted"),
          item("c", "rerereResolved"),
          item("d", "dropped"),
          item("e", "skipped"),
          item("f", "pending"),
        ],
      }).map((entry) => entry.changesetId)
    ).toEqual(["a", "c"])
  })

  it("treats only merged, rolled-back and abandoned changesets as terminal", () => {
    expect([...TERMINAL_CHANGESET_STATES].sort()).toEqual(["abandoned", "merged", "rolledBack"])
  })

  it("holds the integration worktree while preparing, prepared, publishing or stale", () => {
    expect([...ACTIVE_INTEGRATION_STATES].sort()).toEqual([
      "prepared",
      "preparing",
      "publishing",
      "stale",
    ])
  })
})

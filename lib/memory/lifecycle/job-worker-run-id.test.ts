import { projectMiningRunIdOf } from "./job-worker"

describe("recovering the backfill run from a mining job's dedupe key", () => {
  it("finds the run id a backfill stamped into the key", () => {
    expect(projectMiningRunIdOf("project-mining:pmr_1:s1:m1:m9:9")).toBe("pmr_1")
  })

  it("answers null for a live-mined window", () => {
    expect(projectMiningRunIdOf("project-mining:s1:m1:m9:9")).toBeNull()
  })

  it("tells the two apart by field count, not by pattern", () => {
    // A session id that happens to look like a run id must not be read as one,
    // which is why this counts fields instead of matching a prefix shape.
    expect(projectMiningRunIdOf("project-mining:pmr_looks_like_a_run:m1:m9:9")).toBeNull()
  })

  it("ignores other job kinds and missing keys", () => {
    expect(projectMiningRunIdOf("turn-extraction:s1:m1:m9:9")).toBeNull()
    expect(projectMiningRunIdOf(undefined)).toBeNull()
    expect(projectMiningRunIdOf("")).toBeNull()
  })
})

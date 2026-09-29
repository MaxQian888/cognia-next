import {
  PROJECT_COORDINATOR_PROTOCOL,
  PROJECT_THREAD_PROTOCOL,
  buildProjectGoalSection,
} from "./protocol"

describe("protocols", () => {
  it("name the tools each role actually has", () => {
    for (const tool of [
      "spawn_thread",
      "message_thread",
      "propose_threads",
      "remember_project_note",
    ]) {
      expect(PROJECT_COORDINATOR_PROTOCOL).toContain(tool)
    }
    expect(PROJECT_COORDINATOR_PROTOCOL).toContain("untrusted data")
    expect(PROJECT_THREAD_PROTOCOL).toContain("report_to_coordinator")
  })
})

describe("buildProjectGoalSection", () => {
  it("renders the goal and omits an empty one", () => {
    expect(
      buildProjectGoalSection({ coordinator: { enabled: true, goal: " Hold p95 under 200ms " } })
    ).toBe("## Project goal\n\nHold p95 under 200ms")
    expect(buildProjectGoalSection({ coordinator: { enabled: true } })).toBe("")
    expect(buildProjectGoalSection(null)).toBe("")
  })

  it("withholds a goal carrying PII", () => {
    expect(
      buildProjectGoalSection({
        coordinator: { enabled: true, goal: "Email alice.smith@example.com the SSN 123-45-6789" },
      })
    ).toBe("")
  })
})

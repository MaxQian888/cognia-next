import { scheduledSessionAttribution } from "./session-attribution"

describe("scheduledSessionAttribution", () => {
  it("puts the session in the task's workspace and names the task and run", () => {
    expect(
      scheduledSessionAttribution(
        { id: "t1", name: "Morning digest", projectId: "proj-a" },
        "run-9"
      )
    ).toEqual({
      projectId: "proj-a",
      origin: { kind: "scheduled-task", taskId: "t1", taskName: "Morning digest", runId: "run-9" },
    })
  })

  it("leaves the workspace to the default for a task that predates attribution", () => {
    const out = scheduledSessionAttribution({ id: "t1", name: "n" })
    expect(out).not.toHaveProperty("projectId")
    expect(out.origin).toEqual({ kind: "scheduled-task", taskId: "t1", taskName: "n" })
  })
})

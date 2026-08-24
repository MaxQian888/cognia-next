import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { planSessionMove } from "./move-session-workspace"

const target = {
  id: "project-b",
  roots: [{ id: "rb", path: "/repos/b", isPrimary: true }],
  defaultExecutionLocation: "local" as const,
} as unknown as Project

const session = {
  id: "s1",
  projectId: "project-a",
  executionContext: {
    location: "managedWorktree",
    projectId: "project-a",
    projectRoot: "/repos/a",
    workspaceBinding: { kind: "project", projectId: "project-a" },
    taskWorkspace: { taskId: "t1", workspaceKey: "w1" },
  },
} as unknown as ChatSession

const base = { session, target, running: false, now: 1000 }

describe("planSessionMove", () => {
  it("rebuilds the execution context against the destination", () => {
    const plan = planSessionMove(base)
    expect(plan).toMatchObject({ ok: true, projectId: "project-b", previousProjectId: "project-a" })
    if (!plan.ok) throw new Error("expected a plan")
    // Attribution alone would leave the conversation belonging to one project
    // while still running in another's directory.
    expect(plan.executionContext.projectRoot).toBe("/repos/b")
    expect(plan.executionContext.workspaceBinding).toEqual({
      kind: "project",
      projectId: "project-b",
    })
    expect(plan.executionContext.location).toBe("local")
  })

  it("refuses while a turn is in flight", () => {
    // The running turn holds a bundle turn lease against the old workspace;
    // re-pointing underneath it settles its patches into a directory nobody is
    // watching.
    expect(planSessionMove({ ...base, running: true })).toEqual({
      ok: false,
      reason: "session-running",
    })
  })

  it("refuses a handed-off session", () => {
    expect(
      planSessionMove({
        ...base,
        session: {
          ...session,
          handoffLock: { ticketId: "t", state: "held" },
        } as unknown as ChatSession,
      })
    ).toEqual({ ok: false, reason: "session-locked" })
  })

  it("refuses a move that goes nowhere", () => {
    expect(planSessionMove({ ...base, target: null })).toEqual({
      ok: false,
      reason: "unknown-workspace",
    })
    expect(planSessionMove({ ...base, target: { ...target, id: "project-a" } as Project })).toEqual(
      { ok: false, reason: "same-workspace" }
    )
  })

  it("takes the managed contract when the destination has no directory", () => {
    // A rootless workspace has nothing for "local" to mean, whatever its
    // stated default says.
    const plan = planSessionMove({
      ...base,
      target: { ...target, roots: [] } as unknown as Project,
    })
    if (!plan.ok) throw new Error("expected a plan")
    expect(plan.executionContext.location).toBe("managedWorktree")
  })
})

import { resolvePlanExecutionRoot } from "./step-workspace"

const plan = { projectId: "w1", sessionId: "s1" }

describe("resolvePlanExecutionRoot", () => {
  it("prefers the plan's workspace primary root", async () => {
    const resolved = await resolvePlanExecutionRoot(plan, {
      loadWorkspace: async () => ({
        roots: [
          { id: "r0", path: "/extra", isPrimary: false },
          { id: "r1", path: "/repo", isPrimary: true },
        ],
      }),
      loadSession: async () => ({ workingDir: "/session" }),
    })
    expect(resolved).toEqual({ root: "/repo", source: "workspace" })
  })

  it("reads the primary flag, not the position", async () => {
    // The primary is a flag on the row; taking `roots[0]` points the agent at
    // whichever directory happens to sort first.
    const resolved = await resolvePlanExecutionRoot(plan, {
      loadWorkspace: async () => ({
        roots: [{ path: "/first" }, { path: "/actual", isPrimary: true }],
      }),
      loadSession: async () => undefined,
    })
    expect(resolved?.root).toBe("/actual")
  })

  it("falls back to the first root when none is flagged", async () => {
    const resolved = await resolvePlanExecutionRoot(plan, {
      loadWorkspace: async () => ({ roots: [{ path: "/only" }] }),
      loadSession: async () => undefined,
    })
    expect(resolved).toEqual({ root: "/only", source: "workspace" })
  })

  it("falls back to the session's own working directory", async () => {
    const resolved = await resolvePlanExecutionRoot(plan, {
      loadWorkspace: async () => ({ roots: [] }),
      loadSession: async () => ({ workingDir: " /session " }),
    })
    expect(resolved).toEqual({ root: "/session", source: "session" })
  })

  it("is undefined when there is nothing to point an agent at", async () => {
    // A real answer, not a failure: inventing a path is worse than letting the
    // runner use its own default, and the caller skips the slot because there
    // is no directory to exclude anyone from.
    expect(
      await resolvePlanExecutionRoot(plan, {
        loadWorkspace: async () => undefined,
        loadSession: async () => ({ workingDir: "   " }),
      })
    ).toBeUndefined()
  })

  it("skips a workspace read for a plan with no workspace", async () => {
    const seen: string[] = []
    await resolvePlanExecutionRoot(
      { sessionId: "s1" },
      {
        loadWorkspace: async (id) => {
          seen.push(id)
          return undefined
        },
        loadSession: async () => ({ workingDir: "/session" }),
      }
    )
    expect(seen).toEqual([])
  })

  it("survives a database that throws and keeps going down the chain", async () => {
    const resolved = await resolvePlanExecutionRoot(plan, {
      loadWorkspace: async () => {
        throw new Error("no db")
      },
      loadSession: async () => ({ workingDir: "/session" }),
    })
    expect(resolved).toEqual({ root: "/session", source: "session" })
  })

  it("ignores a root whose path is empty or not a string", async () => {
    expect(
      await resolvePlanExecutionRoot(plan, {
        loadWorkspace: async () => ({ roots: [{ path: "  ", isPrimary: true }] }),
        loadSession: async () => undefined,
      })
    ).toBeUndefined()
    expect(
      await resolvePlanExecutionRoot(plan, {
        loadWorkspace: async () => ({ roots: [{ path: 42, isPrimary: true }] }),
        loadSession: async () => undefined,
      })
    ).toBeUndefined()
  })
})

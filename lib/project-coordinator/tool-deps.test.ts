import { resolveProjectCoordinatorToolDeps } from "./tool-deps"

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn(async () => undefined),
  listSessionBranches: jest.fn(async () => []),
}))
jest.mock("@/lib/memory/write/remember-fact", () => ({
  rememberFact: jest.fn(async () => ({ ok: true, scope: "workspace" })),
}))

import { updateSession } from "@/lib/db/sessions"
import { rememberFact } from "@/lib/memory/write/remember-fact"

describe("resolveProjectCoordinatorToolDeps", () => {
  it("remembers notes in workspace scope", async () => {
    await resolveProjectCoordinatorToolDeps().remember({ text: "note", sessionId: "c" })
    expect(rememberFact).toHaveBeenCalledWith({ text: "note", scope: "workspace", sessionId: "c" })
  })

  it("records a declared state on the thread row", async () => {
    const thread = {
      id: "t1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "user" as const },
    }
    await resolveProjectCoordinatorToolDeps().declareThreadState(thread, "blocked")
    expect(updateSession).toHaveBeenCalledWith("t1", {
      projectThread: { ...thread.projectThread, declaredState: "blocked" },
    })
    await resolveProjectCoordinatorToolDeps().declareThreadState(
      { ...thread, projectThread: undefined },
      "blocked"
    )
    expect(updateSession).toHaveBeenCalledTimes(1)
  })

  it("rejects a preference it cannot parse without writing", () => {
    expect(resolveProjectCoordinatorToolDeps().setPreference("p1", "nope", 1)).toMatchObject({
      ok: false,
    })
  })
})

/** @jest-environment jsdom */

import { useProjectStore } from "@/stores/project/project-store"
import { AgentConfigWorkspaceError, resolveAgentConfigWorkspace } from "./workspace"

function seed(activeProjectId: string | null) {
  useProjectStore.setState({
    activeProjectId,
    projects: [
      {
        id: "ws-1",
        name: "Repo",
        customInstructions: "Use pnpm.",
        roots: [
          { id: "r2", path: "/extra", isPrimary: false },
          { id: "r1", path: "/repo", isPrimary: true },
        ],
      },
    ],
  } as never)
}

describe("resolveAgentConfigWorkspace", () => {
  it("defaults to the active workspace, primary root first", () => {
    seed("ws-1")
    const workspace = resolveAgentConfigWorkspace(undefined)
    expect(workspace.id).toBe("ws-1")
    expect(workspace.roots).toEqual(["/repo", "/extra"])
    expect(workspace.promptContext).toEqual({
      workspace: {
        id: "ws-1",
        name: "Repo",
        roots: ["/repo", "/extra"],
        customInstructions: "Use pnpm.",
      },
    })
  })

  it("is account-only for null and when nothing is active", () => {
    seed("ws-1")
    expect(resolveAgentConfigWorkspace(null)).toEqual({ id: null, roots: [], promptContext: {} })
    seed(null)
    expect(resolveAgentConfigWorkspace(undefined).id).toBeNull()
  })

  it("refuses an unknown workspace instead of silently reading account-only", () => {
    seed(null)
    expect(() => resolveAgentConfigWorkspace("nope")).toThrow(AgentConfigWorkspaceError)
  })
})

import { defineWorkspaceBackend } from "./define-workspace-backend"

describe("defineWorkspaceBackend", () => {
  it("returns the workspace backend definition unchanged", () => {
    const def = {
      id: "local",
      label: "Local Workspace",
      entry: "src/workspace.ts",
      export: "createWorkspaceBackend",
      description: "Runs work in a local checkout.",
    }

    expect(defineWorkspaceBackend(def)).toBe(def)
  })
})

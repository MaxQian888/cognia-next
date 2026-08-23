import type { ProjectEnvironment } from "@/types/project-environment"
import {
  mergeWorkspaceConfig,
  parseWorkspaceConfig,
  readWorkspaceConfig,
  WorkspaceConfigError,
} from "./workspace-config"

const local: ProjectEnvironment = {
  id: "env-1",
  projectId: "project-1",
  name: "Local",
  isEnabled: true,
  setupScript: { default: "local setup" },
  actions: [],
  variables: { LOCAL_ONLY: "yes", SHARED: "local" },
  keyringReferences: [{ variable: "TOKEN", keyringRef: "keyring-1" }],
  createdAt: 1,
  updatedAt: 2,
}

describe("workspace repository config", () => {
  it("parses schema v1 and rejects paths that can escape the repository", () => {
    const config = parseWorkspaceConfig(
      JSON.stringify({
        version: 1,
        roots: [{ id: "app", path: ".", role: "primary" }],
        defaults: { execution: "worktree", base: { kind: "workingState" } },
        setup: { default: "pnpm install", byOs: { windows: "pnpm.cmd install" } },
        variables: { NODE_ENV: "development" },
        include: [".env.example"],
        requiredSecrets: ["TOKEN"],
      })
    )
    expect(config.roots[0]).toEqual({ id: "app", path: ".", role: "primary" })
    expect(config.defaults.execution).toBe("worktree")

    expect(() =>
      parseWorkspaceConfig(JSON.stringify({ version: 1, roots: [{ id: "bad", path: "../x" }] }))
    ).toThrow(WorkspaceConfigError)
    expect(() =>
      parseWorkspaceConfig(JSON.stringify({ version: 1, include: ["/private/key"] }))
    ).toThrow(/relative/)
  })

  it("merges repository-safe setup while retaining device-local keyring bindings", () => {
    const config = parseWorkspaceConfig(
      JSON.stringify({
        version: 1,
        setup: { default: "repo setup" },
        actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
        variables: { SHARED: "repo", REPO_ONLY: "yes" },
        requiredSecrets: ["TOKEN", "MISSING"],
      })
    )
    const resolved = mergeWorkspaceConfig(local, config, 10)
    expect(resolved.environment.setupScript.default).toBe("repo setup")
    expect(resolved.environment.variables).toEqual({
      LOCAL_ONLY: "yes",
      SHARED: "repo",
      REPO_ONLY: "yes",
    })
    expect(resolved.environment.keyringReferences).toEqual(local.keyringReferences)
    expect(resolved.missingSecretVariables).toEqual(["MISSING"])
  })

  it("reads only the confined canonical path and treats a missing file as absent", async () => {
    const read = jest.fn(async () => JSON.stringify({ version: 1 }))
    await expect(readWorkspaceConfig("/repo", read)).resolves.toMatchObject({ version: 1 })
    expect(read).toHaveBeenCalledWith("/repo", ".cognia/workspace.json", 262_144)

    await expect(
      readWorkspaceConfig("/repo", async () => {
        throw new Error("No such file")
      })
    ).resolves.toBeNull()
  })
})

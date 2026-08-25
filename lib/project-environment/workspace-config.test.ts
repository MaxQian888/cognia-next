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
    // Local wins on a collision: both sides configure the same workspace, and
    // the more specific layer ("this device") has to beat the shared one, or a
    // value the user set for their own machine stops working after a pull with
    // nothing on screen to connect the two.
    expect(resolved.environment.variables).toEqual({
      LOCAL_ONLY: "yes",
      SHARED: "local",
      REPO_ONLY: "yes",
    })
    // ...and the override is reported, so "local wins" is not invisible.
    expect(resolved.overriddenVariables).toEqual(["SHARED"])
    expect(resolved.environment.keyringReferences).toEqual(local.keyringReferences)
    expect(resolved.missingSecretVariables).toEqual(["MISSING"])
  })

  it("reports no override when the two sides agree", () => {
    const config = parseWorkspaceConfig(
      JSON.stringify({ version: 1, variables: { SHARED: "local", REPO_ONLY: "yes" } })
    )
    expect(mergeWorkspaceConfig(local, config, 10).overriddenVariables).toEqual([])
  })

  describe("capabilities", () => {
    it("parses a per-kind on/off map in the overlay's own shape", () => {
      const config = parseWorkspaceConfig(
        JSON.stringify({
          version: 1,
          capabilities: { skill: { "code-review": true }, mcpServer: { jira: true, brave: false } },
        })
      )
      expect(config.capabilities).toEqual({
        skill: { "code-review": true },
        mcpServer: { jira: true, brave: false },
      })
    })

    it("defaults to empty rather than undefined", () => {
      expect(parseWorkspaceConfig(JSON.stringify({ version: 1 })).capabilities).toEqual({})
    })

    it("rejects an unknown kind loudly instead of ignoring it", () => {
      // A typo'd kind that silently does nothing is how a repository ends up
      // believing it configured something it did not.
      expect(() =>
        parseWorkspaceConfig(JSON.stringify({ version: 1, capabilities: { plugin: { a: true } } }))
      ).toThrow(/Unsupported capability kind/)
    })

    it("rejects a non-boolean state", () => {
      expect(() =>
        parseWorkspaceConfig(JSON.stringify({ version: 1, capabilities: { skill: { a: "on" } } }))
      ).toThrow(/must be true or false/)
    })

    it("drops a kind whose map is empty", () => {
      const config = parseWorkspaceConfig(
        JSON.stringify({ version: 1, capabilities: { skill: {} } })
      )
      expect(config.capabilities).toEqual({})
    })
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

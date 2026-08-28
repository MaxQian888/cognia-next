import {
  gitTargetArgs,
  gitTargetFromPluginCache,
  gitTargetFromRemote,
  parseGitTarget,
} from "./target"

describe("Git repository targets", () => {
  it("preserves desktop absolute paths", () => {
    expect(parseGitTarget("/Users/me/project")).toEqual({
      kind: "local",
      repoPath: "/Users/me/project",
    })
    expect(gitTargetArgs("/Users/me/project")).toEqual({ repoPath: "/Users/me/project" })
  })

  it("round-trips opaque remote workspace handles without paths", () => {
    const key = gitTargetFromRemote("root:opaque/a", "packages/app")

    expect(key).not.toContain("packages/app")
    expect(parseGitTarget(key)).toEqual({
      kind: "remote",
      workspaceId: "root:opaque/a",
      relativePath: "packages/app",
    })
    expect(gitTargetArgs(key)).toEqual({
      workspaceId: "root:opaque/a",
      relativePath: "packages/app",
    })
  })

  it("rejects malformed encoded remote handles", () => {
    expect(() => parseGitTarget("git-workspace:not-base64")).toThrow("Invalid remote Git target")
  })

  it("round-trips a plugin cache without exposing a host path", () => {
    const key = gitTargetFromPluginCache("docs-plugin", ["github.com", "openai", "codex"])

    expect(key).not.toContain("github.com")
    expect(parseGitTarget(key)).toEqual({
      kind: "plugin-cache",
      pluginId: "docs-plugin",
      segments: ["github.com", "openai", "codex"],
    })
    expect(gitTargetArgs(key)).toEqual({
      workspaceRef: {
        kind: "plugin-cache",
        pluginId: "docs-plugin",
        segments: ["github.com", "openai", "codex"],
      },
    })
  })
})

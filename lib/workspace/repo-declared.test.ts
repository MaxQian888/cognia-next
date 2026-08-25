import type { Project } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"

import { parseWorkspaceConfig } from "@/lib/project-environment/workspace-config"
import { workspaceConfigDigest } from "@/lib/project-environment/workspace-config-trust"
import {
  capabilitySeedKey,
  declaredExecutionLocation,
  declaredWorkspaceOf,
  loadDeclaredWorkspace,
  rootSeedKey,
  seedDeclarations,
  seededRootId,
  type DeclaredWorkspace,
} from "./repo-declared"

const REPO = "/repos/app"

const project = {
  roots: [{ id: "r1", path: REPO, isPrimary: true }],
} as Pick<Project, "roots">

const CONFIG = {
  version: 1,
  defaults: { execution: "worktree", base: { kind: "remoteDefault" } },
  roots: [
    { id: "app", path: ".", role: "primary" },
    { id: "web", path: "packages/web", role: "additional" },
  ],
  capabilities: { skill: { "code-review": true }, mcpServer: { jira: true, brave: false } },
}

function parsed() {
  return parseWorkspaceConfig(JSON.stringify(CONFIG))
}

function deps(over: Record<string, unknown> = {}) {
  return {
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    ...over,
  }
}

describe("declaredExecutionLocation", () => {
  it("translates the file's vocabulary into the execution context's", () => {
    expect(declaredExecutionLocation(parsed())).toBe("managedWorktree")
    expect(
      declaredExecutionLocation(
        parseWorkspaceConfig(JSON.stringify({ version: 1, defaults: { execution: "local" } }))
      )
    ).toBe("local")
  })
})

describe("loadDeclaredWorkspace", () => {
  const options = { configRoot: REPO, trustEnabled: true, onWeb: false }

  it("returns the declaration only once the content is approved", async () => {
    const digest = await workspaceConfigDigest(parsed())
    const declared = await loadDeclaredWorkspace(
      project,
      options,
      deps({ approvedDigestFor: jest.fn(async () => digest) })
    )
    expect(declared).toMatchObject({
      executionLocation: "managedWorktree",
      base: { kind: "remoteDefault" },
    })
    expect(declared?.roots.map((r) => r.id)).toEqual(["app", "web"])
  })

  it("returns nothing while approval is pending", async () => {
    expect(await loadDeclaredWorkspace(project, options, deps())).toBeNull()
  })

  it("returns nothing in an untrusted workspace", async () => {
    expect(
      await loadDeclaredWorkspace(
        project,
        options,
        deps({ isRestricted: jest.fn(async () => true) })
      )
    ).toBeNull()
  })

  it("does not half-apply a broken configuration", async () => {
    const digest = await workspaceConfigDigest(parsed())
    expect(
      await loadDeclaredWorkspace(
        project,
        options,
        deps({
          readFile: jest.fn(async () => "{{{"),
          approvedDigestFor: jest.fn(async () => digest),
        })
      )
    ).toBeNull()
  })

  it("falls back to the workspace's primary root when no config root is named", async () => {
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    await loadDeclaredWorkspace(project, { trustEnabled: true, onWeb: false }, deps({ readFile }))
    expect(readFile).toHaveBeenCalledWith(REPO, ".cognia/workspace.json", expect.any(Number))
  })

  it("returns nothing when there is no root at all", async () => {
    const readFile = jest.fn()
    expect(
      await loadDeclaredWorkspace(
        { roots: [] } as Pick<Project, "roots">,
        { trustEnabled: true, onWeb: false },
        deps({ readFile })
      )
    ).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe("seedDeclarations", () => {
  const declared: DeclaredWorkspace = declaredWorkspaceOf(parsed())
  const roots: WorkspaceRoot[] = [{ id: "r1", path: REPO, isPrimary: true }]

  it("seeds capabilities and additional roots on a workspace with no opinion", () => {
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots,
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    expect(result.changed).toBe(true)
    expect(result.overlay).toEqual({
      skill: { "code-review": true },
      mcpServer: { jira: true, brave: false },
    })
    expect(result.roots.map((r) => r.path)).toEqual([REPO, `${REPO}/packages/web`])
    expect(result.roots.find((r) => r.path.endsWith("web"))?.id).toBe(seededRootId("web"))
    expect(result.seeded.sort()).toEqual(
      [
        capabilitySeedKey("skill", "code-review"),
        capabilitySeedKey("mcpServer", "jira"),
        capabilitySeedKey("mcpServer", "brave"),
        rootSeedKey("web"),
      ].sort()
    )
  })

  it("never adds the declared primary root a second time", () => {
    // `roots[0]` is how a config describes itself; adding a copy of the folder
    // the user already opened is noise, not a second mount.
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots,
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    expect(result.roots.filter((r) => r.path === REPO)).toHaveLength(1)
  })

  it("keeps exactly one primary root after seeding", () => {
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots,
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    expect(result.roots.filter((r) => r.isPrimary)).toHaveLength(1)
    expect(result.roots.find((r) => r.isPrimary)?.path).toBe(REPO)
  })

  it("does not re-offer a declaration the user has already answered", () => {
    // The user removed the seeded root and cleared the seeded capability. On
    // the next pull neither may come back — that is the whole point of
    // recording the seed key rather than the thing it created.
    const already = [rootSeedKey("web"), capabilitySeedKey("mcpServer", "jira")]
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots,
      alreadySeeded: already,
      repositoryRoot: REPO,
    })
    expect(result.roots.map((r) => r.path)).toEqual([REPO])
    expect(result.overlay.mcpServer).toEqual({ brave: false })
  })

  it("leaves an existing opinion alone but records that it was offered", () => {
    const result = seedDeclarations({
      declared,
      overlay: { mcpServer: { jira: false } },
      roots,
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    // The repository says on; this workspace already says off. Off wins.
    expect(result.overlay.mcpServer?.jira).toBe(false)
    expect(result.seeded).toContain(capabilitySeedKey("mcpServer", "jira"))
  })

  it("does not duplicate a root the workspace already mounts at that path", () => {
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots: [...roots, { id: "manual", path: `${REPO}/packages/web` }],
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    expect(result.roots.filter((r) => r.path === `${REPO}/packages/web`)).toHaveLength(1)
    // Still recorded as offered, so it is not re-attempted every approval.
    expect(result.seeded).toContain(rootSeedKey("web"))
  })

  it("reports no change when everything was already offered", () => {
    const all = [
      capabilitySeedKey("skill", "code-review"),
      capabilitySeedKey("mcpServer", "jira"),
      capabilitySeedKey("mcpServer", "brave"),
      rootSeedKey("web"),
    ]
    const result = seedDeclarations({
      declared,
      overlay: {},
      roots,
      alreadySeeded: all,
      repositoryRoot: REPO,
    })
    expect(result.changed).toBe(false)
    expect(result.roots).toEqual(roots)
    expect(result.overlay).toEqual({})
  })

  it("handles a configuration that declares nothing", () => {
    const empty = declaredWorkspaceOf(parseWorkspaceConfig(JSON.stringify({ version: 1 })))
    const result = seedDeclarations({
      declared: empty,
      overlay: {},
      roots,
      alreadySeeded: [],
      repositoryRoot: REPO,
    })
    expect(result.changed).toBe(false)
  })

  it("joins declared paths onto the repository root without doubling separators", () => {
    const nested = declaredWorkspaceOf(
      parseWorkspaceConfig(
        JSON.stringify({
          version: 1,
          roots: [
            { id: "a", path: ".", role: "primary" },
            { id: "deep", path: "./a/b", role: "additional" },
          ],
        })
      )
    )
    const result = seedDeclarations({
      declared: nested,
      overlay: {},
      roots,
      alreadySeeded: [],
      repositoryRoot: `${REPO}/`,
    })
    expect(result.roots.map((r) => r.path)).toContain(`${REPO}/a/b`)
  })
})

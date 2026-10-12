import type { Project } from "@/types"

import {
  applyProjectMutate,
  canTransferProject,
  handoffProject,
  parseProjectMutate,
  transferredProject,
  type ProjectMutateStore,
  type TransferredProject,
} from "./project-transfer"

const repository = { remoteUrl: "https://github.com/acme/app.git", capturedAt: 7 }

function project(extra: Partial<Project> = {}): Project {
  return {
    id: "project-app",
    name: "App",
    description: "the app",
    roots: [
      { id: "r1", path: "/Users/me/app", isPrimary: true, label: "app" },
      { id: "r2", path: "/Users/me/docs", isPrimary: false },
    ],
    repository,
    knowledgeBase: [{ id: "k" } as never],
    sessionIds: ["s1"],
    sessionCount: 1,
    messageCount: 0,
    customInstructions: "secret prompt",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastAccessedAt: new Date(0),
    ...extra,
  }
}

function args(
  overrides: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {}
) {
  return {
    operation: "upsert",
    operationId: "op-1",
    project: { ...transferredProject(project()), ...projectOverrides },
    ...overrides,
  }
}

describe("transferredProject", () => {
  it("carries only what locating the code needs", () => {
    expect(transferredProject(project())).toEqual({
      id: "project-app",
      name: "App",
      description: "the app",
      roots: [
        { path: "/Users/me/app", label: "app", isPrimary: true },
        { path: "/Users/me/docs", isPrimary: false },
      ],
      repository,
    })
  })

  it("never moves a workspace without a repository, or the Default one", () => {
    expect(transferredProject(project({ repository: undefined }))).toBeNull()
    expect(canTransferProject(project({ id: "project-default" }))).toBe(false)
    expect(canTransferProject(null)).toBe(false)
    expect(canTransferProject(project())).toBe(true)
  })
})

describe("parseProjectMutate", () => {
  it("accepts what a device sends", () => {
    expect(parseProjectMutate(args()).project.id).toBe("project-app")
  })

  it("refuses anything else", () => {
    for (const bad of [
      args({ operation: "remove" }),
      args({ operationId: "" }),
      args({}, { id: "project-default" }),
      args({}, { name: "  " }),
      args({}, { roots: "not a list" }),
      args({}, { roots: [{ path: "" }] }),
      args({}, { repository: { remoteUrl: "git@github.com:acme/app.git", capturedAt: 1 } }),
      args({}, { repository: { remoteUrl: "https://tok@github.com/acme/app.git", capturedAt: 1 } }),
      args({}, { repository: { remoteUrl: "https://github.com/acme/app.git" } }),
      args({}, { repository: "https://github.com/acme/app.git" }),
    ]) {
      expect(() => parseProjectMutate(bad)).toThrow()
    }
  })

  it("accepts the copy a continued conversation takes, which may have no repository", () => {
    const parsed = parseProjectMutate(args({}, { repository: undefined }))
    expect(parsed.project.repository).toBeUndefined()
    expect(parsed.project).not.toHaveProperty("repository")
  })
})

describe("handoffProject", () => {
  it("copies any workspace but the Default one, with or without a repository", () => {
    expect(handoffProject(project({ repository: undefined }))).toEqual(
      expect.objectContaining({ id: "project-app", roots: expect.any(Array) })
    )
    expect(handoffProject(project({ repository: undefined }))).not.toHaveProperty("repository")
    expect(handoffProject(project())?.repository).toEqual(repository)
    expect(handoffProject(project({ id: "project-default" }))).toBeNull()
  })
})

describe("applyProjectMutate", () => {
  function memoryStore(existing?: Project) {
    const created: TransferredProject[] = []
    const updated: TransferredProject[] = []
    const store: ProjectMutateStore = {
      find: (id) => (existing?.id === id ? existing : undefined),
      create: (copy) => created.push(copy),
      update: (copy) => updated.push(copy),
    }
    return { store, created, updated }
  }

  it("creates the copy once and brings it up to date on a resend", async () => {
    const fresh = memoryStore()
    await expect(applyProjectMutate(args(), fresh.store)).resolves.toEqual({
      id: "project-app",
      created: true,
    })
    expect(fresh.created[0]?.repository).toEqual(repository)

    const again = memoryStore(project())
    await expect(applyProjectMutate(args(), again.store)).resolves.toEqual({
      id: "project-app",
      created: false,
    })
    expect(again.updated).toHaveLength(1)
    expect(again.created).toHaveLength(0)
  })
  it("never clears a repository the host has when the copy carries none", async () => {
    const again = memoryStore(project())
    await applyProjectMutate(args({}, { repository: undefined }), again.store)
    expect(again.updated[0]).not.toHaveProperty("repository")
  })
})

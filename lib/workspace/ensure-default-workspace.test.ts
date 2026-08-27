import type { Project } from "@/types"
import {
  DEFAULT_WORKSPACE_FOLDER_NAME,
  ensureDefaultWorkspace,
  isAutoProvisionEnabled,
  type EnsureDefaultWorkspaceDeps,
} from "./ensure-default-workspace"

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-default",
    name: "Default",
    roots: [],
    sessionIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Project
}

function rooted(path: string): Project {
  return project({
    id: "project-rooted",
    name: "Rooted",
    roots: [{ id: "root-1", path, isPrimary: true }],
  })
}

function deps(overrides: Partial<EnsureDefaultWorkspaceDeps> = {}): EnsureDefaultWorkspaceDeps {
  return {
    listProjects: () => [project()],
    resolveParentDir: async () => "/home/u/Projects",
    createDir: jest.fn(async () => undefined),
    initGit: jest.fn(async () => undefined),
    openAsWorkspace: jest.fn((path: string, name: string) =>
      project({ id: "project-new", name, roots: [{ id: "r", path, isPrimary: true }] })
    ),
    trust: jest.fn(async () => undefined),
    ...overrides,
  }
}

it("provisions a directory when no workspace has one", async () => {
  const d = deps()
  const outcome = await ensureDefaultWorkspace(d)

  expect(outcome).toMatchObject({ kind: "created", path: "/home/u/Projects/Cognia" })
  expect(d.createDir).toHaveBeenCalledWith("/home/u/Projects", DEFAULT_WORKSPACE_FOLDER_NAME)
  expect(d.openAsWorkspace).toHaveBeenCalledWith(
    "/home/u/Projects/Cognia",
    DEFAULT_WORKSPACE_FOLDER_NAME
  )
})

it("trusts the directory it created", async () => {
  // Not optional: workspace trust resolves through session.projectId, so a
  // workspace with a root and no trust row is usable for chat and silently
  // Restricted for every tool — one wall traded for another.
  const d = deps()
  await ensureDefaultWorkspace(d)
  expect(d.trust).toHaveBeenCalledWith("/home/u/Projects/Cognia")
})

it("leaves an existing rooted workspace alone", async () => {
  const d = deps({ listProjects: () => [project(), rooted("/repos/app")] })
  const outcome = await ensureDefaultWorkspace(d)

  expect(outcome).toEqual({ kind: "existing", project: rooted("/repos/app") })
  expect(d.createDir).not.toHaveBeenCalled()
  expect(d.trust).not.toHaveBeenCalled()
})

it("ignores an archived workspace when deciding whether one is rooted", async () => {
  const archived = { ...rooted("/repos/old"), isArchived: true } as Project
  const d = deps({ listProjects: () => [project(), archived] })
  await expect(ensureDefaultWorkspace(d)).resolves.toMatchObject({ kind: "created" })
})

it("reports unavailable rather than guessing when there is no local filesystem", async () => {
  // A browser with no paired host: `resolveProjectsRoot` returns null because
  // home does not resolve. Inventing a path here would create a directory on
  // whatever machine happened to answer.
  const d = deps({ resolveParentDir: async () => null })
  await expect(ensureDefaultWorkspace(d)).resolves.toEqual({
    kind: "unavailable",
    reason: "no-local-filesystem",
  })
  expect(d.createDir).not.toHaveBeenCalled()
})

it("treats a rejected parent lookup as no local filesystem", async () => {
  const d = deps({
    resolveParentDir: async () => {
      throw new Error("no home")
    },
  })
  await expect(ensureDefaultWorkspace(d)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "no-local-filesystem",
  })
})

it("reports a failed mkdir instead of throwing", async () => {
  const d = deps({
    createDir: jest.fn(async () => {
      throw new Error("EACCES")
    }),
  })
  await expect(ensureDefaultWorkspace(d)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "create-failed",
  })
  expect(d.trust).not.toHaveBeenCalled()
})

it("keeps the workspace when git init fails", async () => {
  // The directory exists and is perfectly usable; refusing would orphan it on
  // disk with nothing in the app pointing at it.
  const d = deps({
    initGit: jest.fn(async () => {
      throw new Error("git missing")
    }),
  })
  const outcome = await ensureDefaultWorkspace(d)
  expect(outcome.kind).toBe("created")
  expect(d.trust).toHaveBeenCalled()
})

it("does not fail the provisioning when the trust write throws", async () => {
  const d = deps({
    trust: jest.fn(async () => {
      throw new Error("db closed")
    }),
  })
  await expect(ensureDefaultWorkspace(d)).resolves.toMatchObject({ kind: "created" })
})

describe("automatic provisioning kill switch", () => {
  const storage = (value: string | null): Storage =>
    ({ getItem: () => value }) as unknown as Storage

  it("is on by default, because a fresh install must be able to send", () => {
    expect(isAutoProvisionEnabled(storage(null))).toBe(true)
  })

  it("is off only for an explicit opt-out", () => {
    expect(isAutoProvisionEnabled(storage("false"))).toBe(false)
    expect(isAutoProvisionEnabled(storage("true"))).toBe(true)
    // Anything else is not an opt-out. A stray value must not silently disable
    // the thing that makes the app usable out of the box.
    expect(isAutoProvisionEnabled(storage("no"))).toBe(true)
  })

  it("fails open when storage cannot be read at all", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked")
      },
    } as unknown as Storage
    expect(isAutoProvisionEnabled(throwing)).toBe(true)
    expect(isAutoProvisionEnabled(undefined)).toBe(true)
  })

  it("refuses to provision when switched off, and says so", async () => {
    const created = jest.fn()
    const outcome = await ensureDefaultWorkspace({
      ...deps(),
      listProjects: () => [],
      isEnabled: () => false,
      createDirectory: created,
    } as never)
    expect(outcome).toEqual({ kind: "unavailable", reason: "auto-provision-disabled" })
    expect(created).not.toHaveBeenCalled()
  })

  it("still reports an existing workspace while switched off", async () => {
    // The switch governs creating a directory, not seeing one. Reporting a real
    // workspace as "disabled" would make the switch look like it broke
    // something it never touched.
    const target = rooted("/tmp/w")
    const outcome = await ensureDefaultWorkspace({
      ...deps(),
      listProjects: () => [target],
      isEnabled: () => false,
    } as never)
    expect(outcome).toEqual({ kind: "existing", project: target })
  })
})

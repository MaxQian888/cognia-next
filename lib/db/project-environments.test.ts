import "fake-indexeddb/auto"

import type { ProjectEnvironment } from "@/types/project-environment"
import {
  __enableDbRuntimeForTesting,
  __resetDbForTesting,
  getDb,
  LEGACY_COGNIA_DB_NAME,
} from "./schema"
import {
  deleteProjectEnvironment,
  createProjectEnvironmentVersion,
  compareProjectEnvironmentVersions,
  getProjectEnvironment,
  getProjectEnvironmentVersion,
  listProjectEnvironments,
  listProjectEnvironmentVersions,
  putProjectEnvironment,
  rollbackProjectEnvironmentVersion,
  updateProjectEnvironmentInitialization,
} from "./project-environments"

const environment = (overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment => ({
  id: "env-1",
  projectId: "project-1",
  name: "Development",
  isEnabled: true,
  setupScript: { default: "pnpm install" },
  actions: [],
  variables: { NODE_ENV: "development" },
  keyringReferences: [{ variable: "API_TOKEN", keyringRef: "credential-1" }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe("project environments persistence", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    await indexedDB.deleteDatabase(LEGACY_COGNIA_DB_NAME)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("stores and lists device-local definitions by project", async () => {
    await putProjectEnvironment(environment())
    await putProjectEnvironment(
      environment({ id: "env-2", name: "CI", updatedAt: 3, keyringReferences: [] })
    )
    await putProjectEnvironment(environment({ id: "other", projectId: "project-2" }))

    expect((await listProjectEnvironments("project-1")).map((row) => row.id)).toEqual([
      "env-2",
      "env-1",
    ])
    expect(await getProjectEnvironment("env-1")).toEqual(environment())
  })

  it("rejects variables stored as both plain values and keyring references", async () => {
    await expect(
      putProjectEnvironment(
        environment({
          variables: { API_TOKEN: "must-not-be-stored" },
          keyringReferences: [{ variable: "API_TOKEN", keyringRef: "credential-1" }],
        })
      )
    ).rejects.toThrow(/cannot be plain and keyring-backed/)
  })

  it("updates initialization state without rewriting the definition", async () => {
    await putProjectEnvironment(environment())
    expect(
      await updateProjectEnvironmentInitialization(
        "env-1",
        {
          status: "succeeded",
          scope: "managedWorktree",
          executionRoot: "/worktree",
          startedAt: 5,
          completedAt: 6,
          exitCode: 0,
        },
        6
      )
    ).toBe(true)
    expect((await getProjectEnvironment("env-1"))?.lastInitialization?.status).toBe("succeeded")
    expect((await getProjectEnvironment("env-1"))?.initializationHistory).toHaveLength(1)

    await deleteProjectEnvironment("env-1")
    expect(await getProjectEnvironment("env-1")).toBeUndefined()
  })

  it("creates immutable monotonically versioned environment snapshots", async () => {
    const first = await createProjectEnvironmentVersion(
      environment(),
      { requiredRuntimeCapabilities: ["filesystem"], cacheKey: "lock-v1" },
      10
    )
    const second = await createProjectEnvironmentVersion(
      environment({ setupScript: { default: "pnpm install --frozen-lockfile" } }),
      { requiredRuntimeCapabilities: ["filesystem", "process"], cacheKey: "lock-v2" },
      20
    )

    expect([first.version, second.version]).toEqual([1, 2])
    expect((await listProjectEnvironmentVersions("env-1")).map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ])
    expect((await getProjectEnvironmentVersion(first.id))?.setupScript.default).toBe("pnpm install")
  })

  it("materializes a proposal idempotently without creating a second version", async () => {
    const first = await createProjectEnvironmentVersion(
      environment(),
      { requiredRuntimeCapabilities: ["filesystem"] },
      10,
      "proposal-1"
    )
    const retry = await createProjectEnvironmentVersion(
      environment({ setupScript: { default: "must not replace the first effect" } }),
      { requiredRuntimeCapabilities: ["process"] },
      20,
      "proposal-1"
    )

    expect(retry).toEqual(first)
    expect(await listProjectEnvironmentVersions("env-1")).toHaveLength(1)
  })

  it("compares versions and rolls back by creating a new immutable version", async () => {
    const first = await createProjectEnvironmentVersion(
      environment(),
      { requiredRuntimeCapabilities: ["filesystem"] },
      10
    )
    const second = await createProjectEnvironmentVersion(
      environment({ setupScript: { default: "pnpm ci" } }),
      { requiredRuntimeCapabilities: ["filesystem", "process"] },
      20
    )
    expect(compareProjectEnvironmentVersions(first, second).map((item) => item.field)).toEqual([
      "setupScript",
      "policy",
    ])

    const rollback = await rollbackProjectEnvironmentVersion(first.id, 30)
    expect(rollback).toMatchObject({
      version: 3,
      setupScript: first.setupScript,
      policy: first.policy,
    })
    expect((await getProjectEnvironmentVersion(second.id))?.setupScript.default).toBe("pnpm ci")
  })
})

describe("device-local by construction", () => {
  it("is excluded from Companion sync and desktop delta reads", async () => {
    const { SYNC_HANDLER_TABLES } = await import("@/lib/sync/companion-sync")
    const { readDexieDelta } = await import("@/lib/sync/desktop-sync-source")

    expect(SYNC_HANDLER_TABLES).not.toContain("projectEnvironments")
    await expect(readDexieDelta("projectEnvironments" as never, 0)).rejects.toThrow(
      /unknown sync table/
    )
  })

  it("is absent from the clearable-table surface", async () => {
    const clear = await import("@/lib/data/clear")
    expect(Object.keys(clear)).not.toContain("projectEnvironments")
  })
})

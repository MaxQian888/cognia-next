import type { Project } from "@/types"
import type { ProjectEnvironment } from "@/types/project-environment"

import {
  __resetWorkspaceConfigReports,
  resolveEnvironmentForRun,
  type ResolveEnvironmentDeps,
} from "./resolve-environment"
import { parseWorkspaceConfig } from "./workspace-config"
import { workspaceConfigDigest } from "./workspace-config-trust"

const REPO = "/repos/app"

const project = {
  id: "p1",
  roots: [{ id: "r1", path: REPO, isPrimary: true }],
} as Pick<Project, "roots"> & { id: string }

const local: ProjectEnvironment = {
  id: "env-1",
  projectId: "p1",
  name: "Local",
  isEnabled: true,
  setupScript: { default: "local setup" },
  actions: [],
  variables: { SHARED: "local", LOCAL_ONLY: "yes" },
  keyringReferences: [{ variable: "TOKEN", keyringRef: "k1" }],
  createdAt: 1,
  updatedAt: 2,
}

const CONFIG = {
  version: 1,
  setup: { default: "pnpm install" },
  actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
  variables: { SHARED: "repo", REPO_ONLY: "yes" },
  requiredSecrets: ["TOKEN", "MISSING"],
}

async function approvedDigest(): Promise<string> {
  return workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
}

function deps(over: Partial<ResolveEnvironmentDeps> = {}): Partial<ResolveEnvironmentDeps> {
  return {
    loadProject: jest.fn(async () => project),
    trustEnabled: jest.fn(async () => true),
    onWeb: jest.fn(() => false),
    report: jest.fn(),
    now: () => 999,
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    ...over,
  }
}

const base = {
  environment: local,
  executionRoot: "/repos/.wt/feature",
  surface: "interactive" as const,
  projectId: "p1",
}

beforeEach(() => __resetWorkspaceConfigReports())

describe("resolveEnvironmentForRun", () => {
  it("applies an approved repository configuration on top of the local one", async () => {
    const digest = await approvedDigest()
    const result = await resolveEnvironmentForRun(
      base,
      deps({ approvedDigestFor: jest.fn(async () => digest) })
    )
    expect(result.verdict.kind).toBe("approved")
    expect(result.environment.setupScript.default).toBe("pnpm install")
    expect(result.environment.actions.map((a) => a.id)).toEqual(["test"])
    // Local wins on a collision, and the override is reported rather than silent.
    expect(result.environment.variables).toEqual({
      SHARED: "local",
      LOCAL_ONLY: "yes",
      REPO_ONLY: "yes",
    })
    expect(result.overriddenVariables).toEqual(["SHARED"])
    expect(result.missingSecretVariables).toEqual(["MISSING"])
    // Device-local keyring bindings are never touched by a repository file.
    expect(result.environment.keyringReferences).toEqual(local.keyringReferences)
  })

  it("runs the device-local environment untouched when approval is pending", async () => {
    const result = await resolveEnvironmentForRun(base, deps())
    expect(result.verdict.kind).toBe("unapproved")
    expect(result.environment).toBe(local)
    expect(result.missingSecretVariables).toEqual([])
  })

  it("runs the device-local environment untouched in an untrusted workspace", async () => {
    const result = await resolveEnvironmentForRun(
      base,
      deps({ isRestricted: jest.fn(async () => true) })
    )
    expect(result.verdict.kind).toBe("restricted")
    expect(result.environment).toBe(local)
  })

  it("degrades to the local environment rather than throwing on a broken config", async () => {
    const result = await resolveEnvironmentForRun(
      base,
      deps({ readFile: jest.fn(async () => "{{{") })
    )
    expect(result.verdict.kind).toBe("invalid")
    expect(result.environment).toBe(local)
  })

  it("still returns a runnable environment when the evaluation itself explodes", async () => {
    // A turn must not be taken down by the configuration reader.
    const result = await resolveEnvironmentForRun(
      base,
      deps({
        isRestricted: jest.fn(async () => false),
        approvedDigestFor: jest.fn(async () => {
          throw new Error("db closed")
        }),
      })
    )
    expect(result.environment).toBe(local)
    expect(["invalid", "unapproved"]).toContain(result.verdict.kind)
  })

  it("loads the workspace when the caller does not hand one over", async () => {
    const loadProject = jest.fn(async () => project)
    await resolveEnvironmentForRun(base, deps({ loadProject }))
    expect(loadProject).toHaveBeenCalledWith("p1")
  })

  it("does not load the workspace when one was handed over", async () => {
    const loadProject = jest.fn(async () => project)
    await resolveEnvironmentForRun({ ...base, project }, deps({ loadProject }))
    expect(loadProject).not.toHaveBeenCalled()
  })
})

describe("reporting", () => {
  it("reports a pending approval exactly once per content", async () => {
    const report = jest.fn()
    await resolveEnvironmentForRun(base, deps({ report }))
    await resolveEnvironmentForRun(base, deps({ report }))
    await resolveEnvironmentForRun(base, deps({ report }))
    // A turn resolves its environment on every message; three notifications for
    // one standing fact is how a user learns to dismiss them unread.
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("reports again once the configuration changes", async () => {
    const report = jest.fn()
    await resolveEnvironmentForRun(base, deps({ report }))
    await resolveEnvironmentForRun(
      base,
      deps({
        report,
        readFile: jest.fn(async () => JSON.stringify({ ...CONFIG, setup: { default: "other" } })),
      })
    )
    expect(report).toHaveBeenCalledTimes(2)
  })

  it("reports per workspace, so a second one is not swallowed by the first", async () => {
    const report = jest.fn()
    await resolveEnvironmentForRun(base, deps({ report }))
    await resolveEnvironmentForRun({ ...base, projectId: "p2" }, deps({ report }))
    expect(report).toHaveBeenCalledTimes(2)
  })

  it("says nothing at all when there is no configuration", async () => {
    const report = jest.fn()
    const result = await resolveEnvironmentForRun(
      base,
      deps({
        report,
        readFile: jest.fn(async () => {
          throw new Error("no such file")
        }),
      })
    )
    expect(result.verdict).toEqual({ kind: "absent" })
    expect(report).not.toHaveBeenCalled()
  })

  it("says nothing when the configuration is approved", async () => {
    const report = jest.fn()
    const digest = await approvedDigest()
    await resolveEnvironmentForRun(
      base,
      deps({ report, approvedDigestFor: jest.fn(async () => digest) })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it("passes the surface through, so the wording can differ", async () => {
    const report = jest.fn()
    await resolveEnvironmentForRun({ ...base, surface: "scheduled" }, deps({ report }))
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "scheduled", projectId: "p1" })
    )
  })
})

import type { AgentTeamConfig } from "@/types/agent/agent-team"
import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import {
  SQUAD_READINESS_BLOCKER_CODES,
  evaluateSquadReadiness,
  type SquadReadinessDeps,
} from "./squad-readiness"

const primary = { id: "primary", role: "primary" as const, path: "/repo", writable: true }
const env = { environmentId: "env-1", versionId: "env-1:v3" }
const version = {
  id: "env-1:v3",
  environmentId: "env-1",
  projectId: "ws",
  version: 3,
  policy: { requiredRuntimeCapabilities: [] },
} as unknown as ProjectEnvironmentVersion

const ready: SquadReadinessDeps = {
  getEnvironmentVersion: async () => version,
  preflight: () => ({ ok: true, missing: [] }),
  hostIsAuthoritative: () => true,
  workspaceControllerAvailable: () => true,
  now: () => 1_000,
}

function evaluate(config: Partial<AgentTeamConfig>, deps: SquadReadinessDeps = ready) {
  return evaluateSquadReadiness(
    {
      team: { id: "t", config: config as AgentTeamConfig },
      teammates: [{ role: "lead" }, { role: "teammate" }],
    },
    deps
  )
}

describe("evaluateSquadReadiness", () => {
  it("is ready when both bindings resolve on an authoritative host", async () => {
    const result = await evaluate({ repositories: [primary], environmentRef: env })
    expect(result).toEqual({ ready: true, blockers: [], evaluatedAt: 1_000 })
  })

  it("names every missing binding rather than stopping at the first", async () => {
    const result = await evaluate({})
    expect(result.ready).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual([
      "missing_primary_repository",
      "missing_environment_ref",
    ])
    expect(result.blockers[0]?.action).toBe("configure_repository")
    expect(result.blockers[1]?.action).toBe("configure_environment")
  })

  it("reports an environment version that no longer exists", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: env },
      { ...ready, getEnvironmentVersion: async () => undefined }
    )
    expect(result.blockers).toEqual([
      {
        code: "environment_not_found",
        action: "configure_environment",
        detail: { environmentId: "env-1", versionId: "env-1:v3" },
      },
    ])
  })

  it("reports a version that belongs to another environment as not found", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: { ...env, environmentId: "env-2" } },
      ready
    )
    expect(result.blockers[0]?.code).toBe("environment_not_found")
  })

  it("reports what the host cannot enforce", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: env },
      { ...ready, preflight: () => ({ ok: false, missing: ["sandbox"] }) }
    )
    expect(result.blockers[0]).toMatchObject({
      code: "environment_unenforceable",
      detail: { missingCapabilities: ["sandbox"] },
    })
  })

  it("flags two primaries as ambiguous, with their ids", async () => {
    const result = await evaluate({
      repositories: [primary, { ...primary, id: "second" }],
      environmentRef: env,
    })
    expect(result.blockers[0]).toEqual({
      code: "ambiguous_primary_repository",
      action: "configure_repository",
      detail: { repositoryIds: ["primary", "second"] },
    })
  })

  it("blocks a companion host and points at the desktop", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: env },
      { ...ready, hostIsAuthoritative: () => false }
    )
    expect(result.blockers).toEqual([{ code: "host_unavailable", action: "open_on_host" }])
  })

  it("blocks an authoritative host with no workspace controller", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: env },
      { ...ready, workspaceControllerAvailable: () => false }
    )
    expect(result.blockers[0]?.code).toBe("workspace_controller_unavailable")
  })

  it("requires a worker when the roster is supplied", async () => {
    const result = await evaluateSquadReadiness(
      {
        team: {
          id: "t",
          config: { repositories: [primary], environmentRef: env } as AgentTeamConfig,
        },
        teammates: [{ role: "lead" }],
      },
      ready
    )
    expect(result.blockers).toEqual([{ code: "no_teammates", action: "add_teammate" }])
  })

  it("skips the roster rule for a definition-only check", async () => {
    const result = await evaluateSquadReadiness(
      {
        team: {
          id: "t",
          config: { repositories: [primary], environmentRef: env } as AgentTeamConfig,
        },
      },
      ready
    )
    expect(result.ready).toBe(true)
  })

  it("treats a failing environment lookup as not found rather than throwing", async () => {
    const result = await evaluate(
      { repositories: [primary], environmentRef: env },
      {
        ...ready,
        getEnvironmentVersion: async () => {
          throw new Error("db locked")
        },
      }
    )
    expect(result.blockers[0]?.code).toBe("environment_not_found")
  })

  it("lists every code exactly once", () => {
    expect(new Set(SQUAD_READINESS_BLOCKER_CODES).size).toBe(SQUAD_READINESS_BLOCKER_CODES.length)
  })
})

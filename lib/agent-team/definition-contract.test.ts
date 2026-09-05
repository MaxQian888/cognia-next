import type { AgentTeam, AgentTeamConfig, AgentTeamTemplate } from "@/types/agent/agent-team"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import {
  SQUAD_DEFINITION_CONTRACT_VERSION,
  carriesLegacyRuntimeSelector,
  isOnCurrentSquadContract,
  migrateSquadConfig,
  migrateSquadDefinition,
  migrateSquadTemplate,
  stripLegacyRuntimeSelector,
} from "./definition-contract"

const primary = { id: "primary", role: "primary" as const, path: "/repo", writable: true }
const env = { environmentId: "env-1", versionId: "env-1:v3" }

function team(config: Record<string, unknown>): AgentTeam {
  return {
    id: "team-1",
    name: "Alpha",
    description: "",
    task: "ship",
    status: "idle",
    config: config as unknown as AgentTeamConfig,
    leadId: "lead",
    teammateIds: ["lead"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  }
}

describe("stripLegacyRuntimeSelector", () => {
  it("drops the retired selector and reports it", () => {
    const { config, stripped } = stripLegacyRuntimeSelector({
      runtimeVersion: "legacy",
      maxTeammates: 3,
    })
    expect(stripped).toBe(true)
    expect(config).toEqual({ maxTeammates: 3 })
    expect(carriesLegacyRuntimeSelector(config)).toBe(false)
  })

  it("returns the same object when nothing is retired", () => {
    const input = { maxTeammates: 3 }
    expect(stripLegacyRuntimeSelector(input)).toEqual({ config: input, stripped: false })
  })
})

describe("migrateSquadConfig", () => {
  it("upgrades a durable-v2 definition losslessly: bindings preserved, selector dropped", () => {
    const result = migrateSquadConfig({
      ...({ runtimeVersion: "durable-v2" } as object),
      writeMode: "isolated-parallel",
      repositories: [primary, { id: "dep", role: "dependency", path: "/dep", writable: false }],
      environmentRef: env,
      maxTeammates: 4,
    } as AgentTeamConfig)
    expect(result.changed).toBe(true)
    expect(result.strippedLegacySelector).toBe(true)
    expect(result.inferred).toEqual([])
    expect(result.config).toEqual({
      writeMode: "isolated-parallel",
      repositories: [primary, { id: "dep", role: "dependency", path: "/dep", writable: false }],
      environmentRef: env,
      maxTeammates: 4,
      contractVersion: SQUAD_DEFINITION_CONTRACT_VERSION,
    })
  })

  it("is idempotent", () => {
    const first = migrateSquadConfig({ ...DEFAULT_TEAM_CONFIG, workingDir: "/repo" })
    const second = migrateSquadConfig(first.config)
    expect(second.changed).toBe(false)
    expect(second.config).toEqual(first.config)
    expect(isOnCurrentSquadContract(second.config)).toBe(true)
  })

  it("infers the primary repository from workingDir when it is the only candidate", () => {
    const result = migrateSquadConfig({ workingDir: "/repo" } as AgentTeamConfig)
    expect(result.inferred).toEqual(["repository"])
    expect(result.config.repositories).toEqual([primary])
  })

  it("infers from the workspace root when the Squad names no directory", () => {
    const result = migrateSquadConfig({} as AgentTeamConfig, { repositoryPath: "/repo" })
    expect(result.config.repositories).toEqual([primary])
  })

  it("agrees when workingDir and the workspace root are the same directory", () => {
    const result = migrateSquadConfig({ workingDir: "/repo" } as AgentTeamConfig, {
      repositoryPath: "/repo",
    })
    expect(result.config.repositories).toEqual([primary])
  })

  /** Two different directories is a choice, never a guess. */
  it("refuses to infer when workingDir and the workspace root differ", () => {
    const result = migrateSquadConfig({ workingDir: "/a" } as AgentTeamConfig, {
      repositoryPath: "/b",
    })
    expect(result.inferred).toEqual([])
    expect(result.config.repositories).toBeUndefined()
  })

  it("infers the environment from the single candidate", () => {
    const result = migrateSquadConfig({} as AgentTeamConfig, { environment: env })
    expect(result.inferred).toEqual(["environment"])
    expect(result.config.environmentRef).toEqual(env)
  })

  it("never overrides a valid existing environment binding with a candidate", () => {
    const own = { environmentId: "env-9", versionId: "env-9:v1" }
    const result = migrateSquadConfig({ environmentRef: own } as AgentTeamConfig, {
      environment: env,
    })
    expect(result.config.environmentRef).toEqual(own)
    expect(result.inferred).toEqual([])
  })

  it("drops malformed bindings instead of carrying them", () => {
    const result = migrateSquadConfig({
      repositories: [{ id: "", role: "primary", path: "", writable: true }, primary],
      environmentRef: { environmentId: "env-1", versionId: "" },
    } as unknown as AgentTeamConfig)
    expect(result.config.repositories).toEqual([primary])
    expect(result.config.environmentRef).toBeUndefined()
  })

  it("defaults writeMode to single-writer", () => {
    expect(migrateSquadConfig({} as AgentTeamConfig).config.writeMode).toBe("single-writer")
    expect(
      migrateSquadConfig({ writeMode: "bogus" } as unknown as AgentTeamConfig).config.writeMode
    ).toBe("single-writer")
  })
})

describe("migrateSquadDefinition", () => {
  it("returns the identical team when nothing changes", () => {
    const current = team({
      ...DEFAULT_TEAM_CONFIG,
      repositories: [primary],
      environmentRef: env,
      contractVersion: SQUAD_DEFINITION_CONTRACT_VERSION,
    })
    const result = migrateSquadDefinition(current)
    expect(result.changed).toBe(false)
    expect(result.team).toBe(current)
  })

  it("upgrades a legacy team and leaves the unresolved binding for readiness", () => {
    const legacy = team({ ...DEFAULT_TEAM_CONFIG, runtimeVersion: "legacy" })
    const result = migrateSquadDefinition(legacy)
    expect(result.changed).toBe(true)
    expect(result.strippedLegacySelector).toBe(true)
    expect(result.team.config).not.toHaveProperty("runtimeVersion")
    expect(result.team.config.repositories).toBeUndefined()
    expect(result.team.config.environmentRef).toBeUndefined()
    expect(result.team.config.contractVersion).toBe(SQUAD_DEFINITION_CONTRACT_VERSION)
  })
})

describe("migrateSquadTemplate", () => {
  const template = {
    id: "tpl",
    name: "Review",
    description: "",
    category: "review",
    teammates: [],
  } as unknown as AgentTeamTemplate

  it("strips the selector from template overrides without inferring bindings", () => {
    const result = migrateSquadTemplate({
      ...template,
      config: { runtimeVersion: "durable-v2", maxTeammates: 2 } as unknown as AgentTeamConfig,
    })
    expect(result.changed).toBe(true)
    expect(result.template.config).toEqual({ maxTeammates: 2 })
  })

  it("leaves a clean template alone", () => {
    expect(migrateSquadTemplate(template)).toEqual({ template, changed: false })
  })
})

import { createSquad } from "./create-squad"
import type { AgentTeam, CreateTeamInput } from "@/types/agent/agent-team"
import type { Project } from "@/types"

const project = { id: "ws_1", name: "Work" } as Project

function harness(resolved: Partial<AgentTeam["config"]> | null) {
  const created: CreateTeamInput[] = []
  const createTeam = (input: CreateTeamInput) => {
    created.push(input)
    return { id: "team_a", ...input } as AgentTeam
  }
  return {
    created,
    run: (input: CreateTeamInput) =>
      createSquad(input, { createTeam, project, resolveDurable: async () => resolved }),
  }
}

describe("createSquad", () => {
  /**
   * The defect this exists for: `resolveDurableNewTeamConfig` had no caller, so
   * every new squad was legacy and durable-v2 was reachable only by migrating
   * an existing one.
   */
  it("applies the discovered durable default", async () => {
    const { created, run } = harness({ runtimeVersion: "durable-v2" })
    await run({ name: "Alpha", task: "ship" })
    expect(created[0]?.config?.runtimeVersion).toBe("durable-v2")
  })

  it("creates a legacy squad when nothing durable is available", async () => {
    const { created, run } = harness(null)
    await run({ name: "Alpha", task: "ship" })
    expect(created[0]?.config?.runtimeVersion).toBeUndefined()
  })

  /** An explicit choice is a decision, and discovery must not overrule it. */
  it("lets the caller's own config win", async () => {
    const { created, run } = harness({ runtimeVersion: "durable-v2" })
    await run({ name: "Alpha", task: "ship", config: { runtimeVersion: "legacy" } })
    expect(created[0]?.config?.runtimeVersion).toBe("legacy")
  })

  /** Discovery touches Dexie and the host. Neither may block creating a squad. */
  it("still creates the squad when discovery throws", async () => {
    const created: CreateTeamInput[] = []
    const team = await createSquad(
      { name: "Alpha", task: "ship" },
      {
        createTeam: (input) => {
          created.push(input)
          return { id: "team_a" } as AgentTeam
        },
        project,
        resolveDurable: async () => {
          throw new Error("host unavailable")
        },
      }
    )
    expect(team.id).toBe("team_a")
    expect(created).toHaveLength(1)
  })
})

import { createSquad } from "./create-squad"
import {
  SQUAD_DEFINITION_CONTRACT_VERSION,
  type SquadBindingCandidates,
} from "./definition-contract"
import type { AgentTeam, CreateTeamInput } from "@/types/agent/agent-team"
import type { Project } from "@/types"

const project = { id: "ws_1", name: "Work" } as Project
const env = { environmentId: "env-1", versionId: "env-1:v2" }
const primary = { id: "primary", role: "primary" as const, path: "/repo", writable: true }

function harness(candidates: SquadBindingCandidates | (() => Promise<never>)) {
  const created: CreateTeamInput[] = []
  const createTeam = (input: CreateTeamInput) => {
    created.push(input)
    return { id: "team_a", ...input } as AgentTeam
  }
  return {
    created,
    run: (input: CreateTeamInput) =>
      createSquad(input, {
        createTeam,
        project,
        resolveCandidates: typeof candidates === "function" ? candidates : async () => candidates,
      }),
  }
}

describe("createSquad", () => {
  it("binds the discovered repository and environment on the current contract", async () => {
    const { created, run } = harness({ repositoryPath: "/repo", environment: env })
    await run({ name: "Alpha", task: "ship" })
    expect(created[0]?.config).toEqual({
      writeMode: "single-writer",
      repositories: [primary],
      environmentRef: env,
      contractVersion: SQUAD_DEFINITION_CONTRACT_VERSION,
    })
  })

  /**
   * There is no legacy runtime to fall back to. A Squad without candidates is
   * created unbound and reported as not ready, never as a different kind of
   * Squad.
   */
  it("creates an unbound squad when nothing can be inferred", async () => {
    const { created, run } = harness({})
    await run({ name: "Alpha", task: "ship" })
    expect(created[0]?.config?.repositories).toBeUndefined()
    expect(created[0]?.config?.environmentRef).toBeUndefined()
    expect(created[0]?.config?.contractVersion).toBe(SQUAD_DEFINITION_CONTRACT_VERSION)
  })

  /** An explicit binding is a decision, and discovery must not overrule it. */
  it("lets the caller's own bindings win", async () => {
    const own = { environmentId: "env-9", versionId: "env-9:v1" }
    const { created, run } = harness({ repositoryPath: "/repo", environment: env })
    await run({
      name: "Alpha",
      task: "ship",
      config: { repositories: [{ ...primary, path: "/mine" }], environmentRef: own },
    })
    expect(created[0]?.config?.repositories).toEqual([{ ...primary, path: "/mine" }])
    expect(created[0]?.config?.environmentRef).toEqual(own)
  })

  /** A template or plugin still naming a runtime has that key dropped at the door. */
  it("drops a retired runtime selector from the caller's config", async () => {
    const { created, run } = harness({})
    await run({
      name: "Alpha",
      task: "ship",
      config: { runtimeVersion: "legacy", maxTeammates: 2 } as CreateTeamInput["config"],
    })
    expect(created[0]?.config).not.toHaveProperty("runtimeVersion")
    expect(created[0]?.config?.maxTeammates).toBe(2)
  })

  /** Discovery touches Dexie and the host. Neither may block creating a squad. */
  it("still creates the squad when discovery throws", async () => {
    const { created, run } = harness(async () => {
      throw new Error("host unavailable")
    })
    const team = await run({ name: "Alpha", task: "ship" })
    expect(team.id).toBe("team_a")
    expect(created).toHaveLength(1)
  })
})

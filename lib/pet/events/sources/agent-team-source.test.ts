import { anyTeamActive, wireAgentTeamSource } from "./agent-team-source"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store/store"
import type { PetEvent } from "@/types/pet"

function team(status: string) {
  return { status } as never
}

beforeEach(() => {
  useAgentTeamStore.setState({ teams: {} })
})

describe("anyTeamActive", () => {
  it("is true while a team is planning or executing", () => {
    useAgentTeamStore.setState({ teams: { t: team("executing") } })
    expect(anyTeamActive()).toBe(true)
    useAgentTeamStore.setState({ teams: { t: team("planning") } })
    expect(anyTeamActive()).toBe(true)
    useAgentTeamStore.setState({ teams: { t: team("completed") } })
    expect(anyTeamActive()).toBe(false)
  })
})

describe("wireAgentTeamSource", () => {
  it("emits teamRun on start and success (xp 8) on completion", () => {
    const events: PetEvent[] = []
    const off = wireAgentTeamSource((e) => events.push({ ...e, at: 0 }))
    useAgentTeamStore.setState({ teams: { t: team("executing") } })
    useAgentTeamStore.setState({ teams: { t: team("completed") } })
    off()
    expect(events.map((e) => e.kind)).toEqual(["teamRun", "success"])
    expect(events[1].xp).toBe(8)
  })
})

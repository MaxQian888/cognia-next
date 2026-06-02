// Agent-team runs → pet events. A team that is planning or executing makes the
// pet busy ("teamRun"); finishing celebrates a success worth more XP than a
// single chat turn.

import { useAgentTeamStore } from "@/stores/agent/agent-team-store/store"
import type { PetEmit } from "../pet-event-bus"
import { wireActivitySource } from "./activity-source"

export function anyTeamActive(): boolean {
  return Object.values(useAgentTeamStore.getState().teams).some(
    (t) => t.status === "executing" || t.status === "planning"
  )
}

export function wireAgentTeamSource(emit: PetEmit): () => void {
  return wireActivitySource({
    subscribe: (listener) => useAgentTeamStore.subscribe(() => listener()),
    isActiveNow: anyTeamActive,
    source: "agent-team",
    activeKind: "teamRun",
    xpOnComplete: 8,
    emit,
  })
}

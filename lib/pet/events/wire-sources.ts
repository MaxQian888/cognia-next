// Composes every pet event source into a single wire/dispose call. Mounted once
// by `hooks/pet/use-pet-event-bus.ts`. The source list is injectable so the
// composition is unit-tested without touching real stores.
//
// The scheduler is observed passively via its `cognia-scheduler-executions`
// BroadcastChannel (see `sources/scheduler-source.ts`); any caller can still
// nudge the pet directly via `emitPetEvent(...)`.

import { emitPetEvent, type PetEmit } from "./pet-event-bus"
import { wireChatSource } from "./sources/chat-source"
import { wireTerminalSource } from "./sources/terminal-source"
import { wireAgentTeamSource } from "./sources/agent-team-source"
import { wireConnectorSource } from "./sources/connector-source"
import { wireGoalSource } from "./sources/goal-source"
import { wireWorkflowSource } from "./sources/workflow-source"
import { wireSchedulerSource } from "./sources/scheduler-source"
import { wireHeartbeatSource } from "./sources/heartbeat-source"

export type PetSourceWire = (emit: PetEmit) => () => void

export const DEFAULT_PET_SOURCES: PetSourceWire[] = [
  wireChatSource,
  wireTerminalSource,
  wireAgentTeamSource,
  wireConnectorSource,
  wireGoalSource,
  wireWorkflowSource,
  wireSchedulerSource,
  // Wall-clock self-tick: closes the neglect → unwell → notify loop on elapsed
  // time when no subsystem activity is nudging the pet.
  wireHeartbeatSource,
]

export function wirePetSources(
  emit: PetEmit = emitPetEvent,
  sources: PetSourceWire[] = DEFAULT_PET_SOURCES
): () => void {
  const disposers = sources.map((wire) => wire(emit))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

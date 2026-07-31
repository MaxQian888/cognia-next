// Composes every pet event source into a single wire/dispose call. Mounted once
// by `hooks/pet/use-pet-event-bus.ts`. The source list is injectable so the
// composition is unit-tested without touching real stores.
//
// The scheduler is observed passively via its `cognia-scheduler-executions`
// BroadcastChannel (see `sources/scheduler-source.ts`); any caller can still
// nudge the pet directly via `emitPetEvent(...)`.

import { emitPetEvent, type PetEmit } from "./pet-event-bus"
import { wireChatSource } from "./sources/chat-source"
import { wireAttentionSource } from "./sources/attention-source"
import { wireCaptureSource } from "./sources/capture-source"
import { wireTerminalSource } from "./sources/terminal-source"
import { wireGitSource } from "./sources/git-source"
import { wireAgentTeamSource } from "./sources/agent-team-source"
import { wireBackgroundTaskSource } from "./sources/background-task-source"
import { wireConnectorSource } from "./sources/connector-source"
import { wireGoalSource } from "./sources/goal-source"
import { wireWorkflowSource } from "./sources/workflow-source"
import { wireSchedulerSource } from "./sources/scheduler-source"
import { wireSchedulerDueSource } from "./sources/scheduler-due-source"
import { wireHeartbeatSource } from "./sources/heartbeat-source"
import { wireBirthdaySource } from "./sources/birthday-source"

export type PetSourceWire = (emit: PetEmit) => () => void

export const DEFAULT_PET_SOURCES: PetSourceWire[] = [
  wireChatSource,
  wireAttentionSource,
  wireCaptureSource,
  wireTerminalSource,
  wireGitSource,
  wireAgentTeamSource,
  wireBackgroundTaskSource,
  wireConnectorSource,
  wireGoalSource,
  wireWorkflowSource,
  wireSchedulerSource,
  // Forward-looking "task is due" reminder cue from the native alarm daemon.
  wireSchedulerDueSource,
  // Wall-clock self-tick: closes the neglect → unwell → notify loop on elapsed
  // time when no subsystem activity is nudging the pet.
  wireHeartbeatSource,
  // Hatch-anniversary celebration (once per birthday local-day).
  wireBirthdaySource,
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

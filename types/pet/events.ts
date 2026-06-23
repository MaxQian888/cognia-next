// Events fed into the PetEventBus. Subsystems never import pet internals; thin
// adapters in `lib/pet/events/sources/*` translate their native lifecycle into
// these neutral events (+ an XP weight). See `lib/pet/events/pet-event-bus.ts`.

/** Which subsystem produced the event ("user" = direct interaction). */
export type PetEventSource =
  | "chat"
  | "agent-team"
  | "goal"
  | "scheduler"
  | "connector"
  | "terminal"
  | "workflow"
  | "user"
  | "system"

/** Neutral event vocabulary the reducer + XP table understand. */
export type PetEventKind =
  // agent-state radar
  | "thinking"
  | "waiting"
  | "review"
  | "success"
  | "error"
  | "idle"
  // subsystem milestones (XP-bearing)
  | "goalProgress"
  | "goalComplete"
  | "teamRun"
  | "inboundMessage"
  | "scheduledRun"
  | "workflowRun"
  // direct user interactions
  | "fed"
  | "played"
  | "petted"
  | "talked"
  | "slept"
  | "cleaned"
  | "treated"
  // lifecycle
  | "hatched"
  | "levelUp"
  | "evolved"
  | "achievementUnlocked"
  | "greeting"

export interface PetEvent {
  source: PetEventSource
  kind: PetEventKind
  /** XP awarded by this event (optional; resolved via the award table if absent). */
  xp?: number
  /** Free-form context (e.g. goalId, sessionId) for bubbles/achievements. */
  meta?: Record<string, unknown>
  /** Epoch ms. */
  at: number
}

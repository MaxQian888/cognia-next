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
  | "twin"
  // Unified Control Center projection (approval / HITL / fleet waits).
  | "attention"
  | "source-control"
  | "background-task"
  | "capture"
  | "user"
  | "system"
  // Plugin-originated interactions/rewards via ctx.pet (rate-limited +
  // budget-clamped in lib/plugin/api/pet-api.ts; meta carries pluginId).
  | "plugin"

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
  // a scheduled task began running (expressive "thinking")
  | "scheduledRunStarting"
  // a scheduled task/reminder is due right now (drives the pet reminder)
  | "scheduledRunDue"
  | "workflowRun"
  // ambient twin-awareness signals (opt-in; job metadata only, never content)
  | "twinBusy"
  | "twinMilestone"
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
  // care transition (controller-emitted on well → unwell; 0 XP)
  | "unwell"
  // daily-care streak advanced to a new day (controller-emitted, ceremony
  // only — 0 XP/coins; meta carries { days, multiplier })
  | "streakDay"
  // hatch anniversary (birthday-source, once per birthday local-day)
  | "birthday"

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

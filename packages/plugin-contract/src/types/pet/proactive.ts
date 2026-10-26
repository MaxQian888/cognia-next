// Persisted counters for the proactive speak engine. Lives as a non-indexed
// field on the singleton `petProfile` row (no Dexie version bump). All logic
// that advances/normalizes this shape is pure and lives in
// `lib/pet/llm/proactive/scheduler-state.ts`.

export interface ProactiveState {
  /** Epoch ms of the last accepted proactive utterance, or null. */
  lastSpokeAtMs: number | null
  /** Local day (YYYY-MM-DD) the counters belong to. */
  dayKey: string | null
  /** Utterances spoken on `dayKey`. */
  spokenToday: number
  /** Greeting windows already used, e.g. "2026-06-05:morning". */
  greetedWindows: string[]
}

// Persisted per-kind interaction cooldown. Lives as a non-indexed field on the
// singleton `petProfile` row (no Dexie version bump), the same contract as
// `proactiveState`, `statProgress`, `care`, `cosmetic`, `coins` and `streak`.
// All logic that advances or normalizes this shape is pure and lives in
// `lib/pet/interaction/gate.ts`.
//
// It is persisted rather than held in the zustand store because the store is
// per-window and per-session: it reset on every reload, and the main window,
// the overlay and the popup each held their own copy, so three surfaces
// disagreed about whether the same pet had just been fed.

export interface PetInteractionGateState {
  /** Epoch ms of the last ACCEPTED interaction, keyed by event kind. */
  lastAtByKind: Record<string, number>
}

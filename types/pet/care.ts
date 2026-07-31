// Persistent care condition derived from sustained low needs, plus a rolling
// care-quality score. Lives as a non-indexed field on the singleton `petProfile`
// row (no Dexie version bump — mirrors `ProactiveState`). All logic that advances
// this shape is pure and lives in `lib/pet/care/condition.ts`.

/** Whether the pet is currently fine or needs attention. */
export type PetCondition = "well" | "unwell"

export interface PetCareState {
  /**
   * Epoch ms when energy OR mood first dropped below the unwell threshold and
   * stayed low; null when the pet is comfortably above the recovery threshold.
   */
  lowSince: number | null
  /** Current derived condition — persisted so the renderer + notify are stable. */
  condition: PetCondition
  /** Epoch ms of the last "became unwell" notify (set by the controller). */
  notifiedAt: number | null
  /** True once the pet has ever been unwell (drives the recovery achievement). */
  everUnwell: boolean
  /** Rolling lifetime care-quality score 0–100 (EMA of average needs). */
  careQuality: number
}

/** A fresh pet: well, never unwell, neutral rolling quality (earned upward by
 *  sustained good care, so milestones like "devoted caretaker" aren't free). */
export const DEFAULT_CARE_STATE: PetCareState = {
  lowSince: null,
  condition: "well",
  notifiedAt: null,
  everUnwell: false,
  careQuality: 50,
}

function clampQuality(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CARE_STATE.careQuality
  return Math.max(0, Math.min(100, value as number))
}

/** Fill missing fields from defaults (legacy rows written before this field). */
export function normalizeCareState(c?: Partial<PetCareState>): PetCareState {
  return {
    lowSince: typeof c?.lowSince === "number" ? c.lowSince : null,
    condition: c?.condition === "unwell" ? "unwell" : "well",
    notifiedAt: typeof c?.notifiedAt === "number" ? c.notifiedAt : null,
    everUnwell: c?.everUnwell === true,
    careQuality: clampQuality(c?.careQuality),
  }
}

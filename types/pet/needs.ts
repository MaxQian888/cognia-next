// The nurture "needs" loop. Needs decay over wall-clock time and are restored by
// interactions (feed → energy, play → mood, pet/talk → bond). Decay is computed
// lazily on read from `lastTickAt` (mirrors the twin compute-on-access pattern),
// so no background timer is required. See `lib/pet/needs/decay.ts`.

export type PetNeedKind = "energy" | "mood" | "bond"

export interface PetNeeds {
  /** 0–100. Low energy → the pet sleeps. */
  energy: number
  /** 0–100. Low mood → the pet looks sad. */
  mood: number
  /** 0–100. Bond/intimacy — grows slowly, decays slowly. */
  bond: number
  /** ISO 8601 timestamp of the last time needs were settled to storage. */
  lastTickAt: string
}

/** Per-need decay rate (points lost per hour) and the floor it cannot fall below. */
export interface NeedDecayRate {
  perHour: number
  floor: number
}

/** Full decay configuration, one entry per need kind. */
export type NeedDecayConfig = Record<PetNeedKind, NeedDecayRate>

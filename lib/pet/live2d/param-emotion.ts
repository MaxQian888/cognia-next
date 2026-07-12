// Pure parameter envelopes giving the Live2D skin a visible presence for the
// three most common AI states — thinking / waiting / review — which map to the
// bare Idle motion group on most models (7 of 12 states collapsed to plain
// idle; these are the ones the pet spends whole work sessions in). Values are
// written each frame in `beforeModelUpdate` (after motions, before commit) by
// `use-live2d-param-emotion.ts`, so they win over the idle motion's own values.
// Standard Cubism parameter ids; models lacking one simply ignore the write.

import type { PetVisualState } from "@/types/pet"

export interface ParamWrite {
  id: string
  value: number
}

const TWO_PI = Math.PI * 2

/** States that get a parameter envelope (everything else returns []). */
export const PARAM_EMOTION_STATES: ReadonlySet<PetVisualState> = new Set([
  "thinking",
  "waiting",
  "review",
] as PetVisualState[])

/**
 * Parameter writes for `state` at `elapsedMs` since the state was entered.
 * Deterministic sin envelopes:
 *  - thinking: slow head sway (Z) + eyes scanning side to side — "working".
 *  - waiting: gentle expectant nod bounce (Y) — "ready when you are".
 *  - review: head tilt sweep (X) + eye scan — "reading the output".
 */
export function emotionParamsAt(state: PetVisualState, elapsedMs: number): ParamWrite[] {
  const t = elapsedMs / 1000
  switch (state) {
    case "thinking":
      return [
        { id: "ParamAngleZ", value: Math.sin(t * TWO_PI * 0.25) * 8 },
        { id: "ParamEyeBallX", value: Math.sin(t * TWO_PI * 0.35) * 0.7 },
      ]
    case "waiting":
      return [
        { id: "ParamAngleY", value: Math.sin(t * TWO_PI * 0.9) * 5 },
        { id: "ParamBodyAngleY", value: Math.sin(t * TWO_PI * 0.9) * 3 },
      ]
    case "review":
      return [
        { id: "ParamAngleX", value: Math.sin(t * TWO_PI * 0.15) * 10 },
        { id: "ParamEyeBallX", value: Math.sin(t * TWO_PI * 0.5) * 0.8 },
      ]
    default:
      return []
  }
}

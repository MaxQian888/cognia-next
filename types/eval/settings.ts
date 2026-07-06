/**
 * Project-level Agent-Eval preferences (Settings → Agent 评估).
 *
 * These are the run-time DEFAULTS the eval UI reads before a user overrides
 * anything per-run: which model judges, how many repetitions, which scorers are
 * pre-selected, the gate template stamped onto brand-new datasets, and a cost
 * guard. Stored on `AppSettings.evalSettings` (one Dexie write with the rest of
 * settings); the run-config dialog and `createDataset` consume them.
 *
 * Kept intentionally small: dataset content, per-dataset gates, and calibration
 * sets remain in their own Dexie tables — this holds only the cross-cutting
 * defaults that previously had no home and could only be set per-run.
 */

import type { GateThresholds } from "./gate"

export interface EvalSettings {
  /**
   * Model that runs the LLM judge / RAG-generation scorers, as a
   * provider-qualified model id (same id space as the composer model picker).
   * Undefined = let the resolver pick (cross-model default). Ignored when
   * {@link EvalSettings.deterministicOnly} is on.
   */
  judgeModel?: string
  /**
   * Force the deterministic scorer tier only — never build a judge client even
   * if one is configured. Makes runs fully offline / zero-cost and
   * reproducible; the LLM judge / RAG-groundedness scorers are skipped.
   */
  deterministicOnly?: boolean
  /** Default repetitions (pass^k reliability) pre-filled in the run dialog. 1..10. */
  defaultK: number
  /**
   * Scorer ids pre-checked in the run dialog. Empty = all scorers. Sanitized
   * against the scorer catalog on read so a renamed scorer can't wedge the UI.
   */
  defaultScorerIds: string[]
  /**
   * Gate thresholds stamped onto newly created datasets (users can still edit
   * per-dataset afterwards). Undefined = new datasets start with no gate.
   */
  defaultGate?: GateThresholds
  /**
   * Warn before launching a run whose ESTIMATED total cost exceeds this many
   * USD. Undefined / 0 disables the guard.
   */
  costWarnUsd?: number
}

/** Baseline used by DEFAULTS and as the merge base when the field is absent. */
export const DEFAULT_EVAL_SETTINGS: EvalSettings = {
  defaultK: 1,
  defaultScorerIds: [],
}

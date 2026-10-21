/**
 * The plugin contract's share of `lib/db/pet-models.ts`, which re-exports these.
 */
import type { Live2dCompatibilitySummary } from "../pet/live2d/types"
import type {
  Live2dMotionOverrides,
  Live2dParameterMapping,
  Live2dTransform,
} from "../../types/pet"

/** Metadata row for one stored Live2D model. */
export interface PetModelRow {
  /** Collision-resistant id (`pm_<base36ts>_<rand>`) or an explicit override. */
  id: string
  /** Human-facing model name (derived from the folder/zip at import). */
  name: string
  /** Where the model came from — a user import or a downloaded sample. */
  source: "import" | "sample"
  /** For `source === "sample"`, the catalog id it was downloaded from. */
  sampleId?: string
  /** Relative path of the `.model3.json` / `.model.json` settings file. */
  settingsPath: string
  /** Motion group names declared by the model (drives state→motion mapping). */
  motionGroups: string[]
  /** Expression ids declared by the model (drives one-shot→expression mapping). */
  expressionIds: string[]
  /** Sum of all asset blob sizes in bytes (storage accounting). */
  totalBytes: number
  /** Epoch ms when the model was added. */
  createdAt: number
  /**
   * Per-model render transform (additive, non-indexed — absent on legacy rows;
   * normalized to defaults on read via `normalizeTransform`).
   */
  transform?: Live2dTransform
  /**
   * Per-model state→motion/expression overrides (additive, non-indexed —
   * absent = naming-convention mapping only).
   */
  motionOverrides?: Live2dMotionOverrides
  /** Optional parameter-role overrides; null disables a role. */
  parameterMapping?: Live2dParameterMapping
  /** Versioned import/revalidation result (non-indexed, additive). */
  compatibility?: Live2dCompatibilitySummary
}

// Shared Live2D type currency for the import / validation / loading pipeline.
// Logic-free by design — every consuming module owns its own behaviour and
// co-located test. File names can't carry slashes, so a model's relative path
// travels alongside its blob as `ModelFileEntry.path`.

/** One file of a Live2D model bundle, keyed by its relative path. */
export interface ModelFileEntry {
  /** Path relative to the model root, POSIX-normalized (forward slashes). */
  path: string
  /** Raw file bytes. */
  blob: Blob
}

/**
 * Parsed, resolved description of a modern (Cubism 3–5) model. All paths are
 * resolved relative to the settings file's directory into full entry paths.
 */
export interface Live2DManifest {
  /** Only modern Cubism is supported in v1. */
  kind: "modern"
  /** Full entry path of the `.model3.json` settings file. */
  settingsPath: string
  /** Full entry path of the `.moc3` file. */
  mocPath: string
  /** Full entry paths of every referenced texture. */
  texturePaths: string[]
  /** Motion group names (object keys of `FileReferences.Motions`). */
  motionGroups: string[]
  /** Expression ids (`FileReferences.Expressions[].Name`). */
  expressionIds: string[]
  /** Full entry path of the physics file, when present. */
  physicsPath?: string
  /** Full entry path of the pose file, when present. */
  posePath?: string
}

/** The motion/expression surface a loaded model exposes to the state mapper. */
export interface Live2dCapabilities {
  motionGroups: string[]
  expressionIds: string[]
  /**
   * Motion count per group, when known (populated by the canvas from the
   * model's settings). Lets the motion hook draw a random index for override
   * entries that leave `motionIndex` unset.
   */
  motionGroupCounts?: Record<string, number>
}

/** A render-agnostic plan describing which motion/expression to play. */
export interface MotionPlan {
  /** Chosen motion group, when one matched the model's capabilities. */
  motionGroup?: string
  /** Index within the chosen group (defaults to 0 at the call site). */
  motionIndex?: number
  /** Engine `MotionPriority` bucket. */
  priority: "idle" | "normal" | "force"
  /** Chosen expression id, when one matched. */
  expressionId?: string
  /**
   * When true, no motion matched — the caller should let the engine's native
   * breathing / eye-blink carry the pet rather than forcing a motion.
   */
  parameterFallback: boolean
}

/** Import-time failure codes (the UI maps these to localized copy). */
export type Live2dImportError =
  | "noSettings"
  | "multipleSettings"
  | "invalidJson"
  | "missingReferenced"
  | "tooLarge"
  | "cubism2Unsupported"
  | "zipFailed"

/** A fully-validated model ready to persist or load. */
export interface ValidatedModel {
  manifest: Live2DManifest
  entries: ModelFileEntry[]
  totalBytes: number
}

/** Result of `validateLive2dImport`. */
export type ImportValidationResult =
  | { ok: true; model: ValidatedModel }
  | { ok: false; code: Live2dImportError; detail?: string }

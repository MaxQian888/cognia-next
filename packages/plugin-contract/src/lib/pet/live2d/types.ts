/**
 * The plugin contract's share of `lib/pet/live2d/types.ts`, which re-exports these.
 */
/** Import-time failure codes (the UI maps these to localized copy). */
export type Live2dImportError =
  | "noSettings"
  | "multipleSettings"
  | "invalidJson"
  | "missingReferenced"
  | "tooLarge"
  | "cubism2Unsupported"
  | "zipFailed"
  | "ambiguousPath"
  | "duplicatePath"
  | "pathTraversal"
  | "corruptTexture"

export interface Live2dCompatibilityDiagnostic {
  code:
    | Live2dImportError
    | "missingMotion"
    | "missingExpression"
    | "missingSound"
    | "missingPhysics"
    | "missingPose"
    | "missingMetadata"
  severity: "warning" | "error"
  path?: string
}

export interface Live2dCompatibilitySummary {
  version: 1
  status: "ready" | "degraded" | "invalid"
  diagnostics: Live2dCompatibilityDiagnostic[]
  usableMotionGroups: string[]
  usableExpressionIds: string[]
  usableParameterIds: string[]
  resourceCost: { totalBytes: number; fileCount: number; textureBytes: number }
}

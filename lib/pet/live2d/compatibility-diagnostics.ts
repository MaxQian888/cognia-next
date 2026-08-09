import type { PetAssetDiagnostic, PetAssetDiagnosticCode } from "@/types/pet"
import type { Live2dCompatibilityDiagnostic } from "./types"

const OPTIONAL_CODES = new Set<Live2dCompatibilityDiagnostic["code"]>([
  "missingMotion",
  "missingExpression",
  "missingSound",
  "missingPhysics",
  "missingPose",
  "missingMetadata",
])

const DIRECT_CODES: Partial<Record<Live2dCompatibilityDiagnostic["code"], PetAssetDiagnosticCode>> =
  {
    ambiguousPath: "ambiguousPath",
    duplicatePath: "duplicatePath",
    pathTraversal: "pathTraversal",
    corruptTexture: "corruptTexture",
    cubism2Unsupported: "cubism2Unsupported",
    tooLarge: "assetTooLarge",
  }

/** Adapt import-specific findings to the renderer/UI diagnostic contract. */
export function toPetAssetDiagnostics(
  diagnostics: readonly Live2dCompatibilityDiagnostic[]
): PetAssetDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code:
      DIRECT_CODES[diagnostic.code] ??
      (OPTIONAL_CODES.has(diagnostic.code)
        ? "missingOptionalResource"
        : diagnostic.code === "missingReferenced"
          ? "missingRequiredResource"
          : "invalidSettings"),
    severity: diagnostic.severity,
    path: diagnostic.path,
    detail: diagnostic.code,
    recoverable: true,
  }))
}

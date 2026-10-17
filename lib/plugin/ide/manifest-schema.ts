import type { ErrorObject } from "ajv"
import validate from "@/packages/plugin-sdk/contract/ide-manifest-validator.generated.cjs"

export interface IdeManifestSchemaDiagnostic {
  code: "IDE_MANIFEST_SCHEMA_INVALID"
  field: string
  keyword: string
  message: string
  params: Record<string, unknown>
}

export function validateIdeManifestSchema(value: unknown): IdeManifestSchemaDiagnostic[] {
  if (validate(value)) return []
  return (validate.errors ?? []).map(toDiagnostic)
}

function toDiagnostic(error: ErrorObject): IdeManifestSchemaDiagnostic {
  const path = decodeJsonPointer(error.instancePath)
  const suffix =
    error.keyword === "required" && typeof error.params.missingProperty === "string"
      ? `.${error.params.missingProperty}`
      : error.keyword === "additionalProperties" &&
          typeof error.params.additionalProperty === "string"
        ? `.${error.params.additionalProperty}`
        : ""
  return {
    code: "IDE_MANIFEST_SCHEMA_INVALID",
    field: `ide${path}${suffix}`,
    keyword: error.keyword,
    message: error.message ?? "does not match the managed IDE manifest schema",
    params: { ...error.params },
  }
}

function decodeJsonPointer(pointer: string): string {
  if (!pointer) return ""
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^(?:0|[1-9]\d*)$/u.test(segment) ? `[${segment}]` : `.${segment}`))
    .join("")
}

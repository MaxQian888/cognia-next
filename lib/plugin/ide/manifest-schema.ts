import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import ideManifestSchema from "@/packages/plugin-sdk/contract/ide-manifest.schema.json"

export interface IdeManifestSchemaDiagnostic {
  code: "IDE_MANIFEST_SCHEMA_INVALID"
  field: string
  keyword: string
  message: string
  params: Record<string, unknown>
}

let compiledValidator: ValidateFunction | undefined

export function validateIdeManifestSchema(value: unknown): IdeManifestSchemaDiagnostic[] {
  const validate = getValidator()
  if (validate(value)) return []
  return (validate.errors ?? []).map(toDiagnostic)
}

function getValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    unicodeRegExp: false,
  })
  ajv.addFormat("regex", {
    type: "string",
    validate(value: string) {
      try {
        new RegExp(value)
        return true
      } catch {
        return false
      }
    },
  })
  ajv.addFormat("uri", {
    type: "string",
    validate: isUri,
  })
  ajv.addFormat("uri-reference", {
    type: "string",
    validate(value: string) {
      try {
        new URL(value, "https://cognia.invalid/")
        return !/[\u0000-\u001f\u007f\s]/u.test(value)
      } catch {
        return false
      }
    },
  })
  ajv.addFormat("color-hex", {
    type: "string",
    validate: /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu,
  })
  compiledValidator = ajv.compile(ideManifestSchema)
  return compiledValidator
}

function isUri(value: string): boolean {
  if (/[\u0000-\u001f\u007f\s]/u.test(value)) return false
  try {
    const uri = new URL(value)
    return uri.protocol.length > 1
  } catch {
    return false
  }
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

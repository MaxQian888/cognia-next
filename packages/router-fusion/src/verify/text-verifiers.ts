/**
 * Runtime verifiers for text results (DESIGN §25.3).
 *
 * `text_basic`: non-empty, length bound, required fields present for a JSON
 * result, forbidden markers absent. It proves format, not truth, and the report
 * says `schema_only`.
 * `schema_fixture`: a JSON result validated against a JSON Schema subset and
 * compared with fixture expectations. Anything the checker cannot evaluate is
 * `inconclusive`, never a pass.
 */

import type { VerificationCheck, VerificationReport } from "../contracts/schemas"
import { CONTRACT_SCHEMA_VERSION } from "../contracts/schemas"

export const TEXT_VERIFIER_VERSION = "text-verifiers-1"

export interface TextBasicRules {
  maxChars?: number
  requiredJsonFields?: string[]
  forbiddenSubstrings?: string[]
  expectJson?: boolean
}

function check(
  check_id: string,
  kind: string,
  status: VerificationCheck["status"],
  summary: string
): VerificationCheck {
  return { check_id, kind, status, summary, executed_by: "runtime", artifact_refs: [] }
}

export function parseJsonDocument(
  text: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  try {
    return { ok: true, value: JSON.parse(fenced ? fenced[1] : trimmed) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function aggregate(checks: VerificationCheck[]): VerificationReport["status"] {
  if (checks.some((c) => c.status === "failed")) return "failed"
  if (checks.some((c) => c.status === "inconclusive")) return "inconclusive"
  if (checks.length === 0 || checks.every((c) => c.status === "not_applicable"))
    return "not_applicable"
  return "passed"
}

export function verifyTextBasic(input: {
  reportId: string
  text: string
  rules?: TextBasicRules
  revision?: string | null
}): VerificationReport {
  const rules = input.rules ?? {}
  const checks: VerificationCheck[] = []
  checks.push(
    check(
      "non_empty",
      "format",
      input.text.trim().length > 0 ? "passed" : "failed",
      "result is not empty"
    )
  )
  if (rules.maxChars !== undefined) {
    checks.push(
      check(
        "max_length",
        "format",
        input.text.length <= rules.maxChars ? "passed" : "failed",
        `result length ${input.text.length} ≤ ${rules.maxChars}`
      )
    )
  }
  if (rules.expectJson || rules.requiredJsonFields?.length) {
    const parsed = parseJsonDocument(input.text)
    checks.push(
      check(
        "json_parse",
        "format",
        parsed.ok ? "passed" : "failed",
        parsed.ok ? "result parses as JSON" : `invalid JSON: ${parsed.error}`
      )
    )
    if (parsed.ok && rules.requiredJsonFields?.length) {
      const record =
        parsed.value && typeof parsed.value === "object"
          ? (parsed.value as Record<string, unknown>)
          : {}
      const missing = rules.requiredJsonFields.filter((field) => !(field in record))
      checks.push(
        check(
          "required_fields",
          "format",
          missing.length === 0 ? "passed" : "failed",
          missing.length === 0 ? "all required fields present" : `missing: ${missing.join(", ")}`
        )
      )
    }
  }
  if (rules.forbiddenSubstrings?.length) {
    const hits = rules.forbiddenSubstrings.filter((needle) => input.text.includes(needle))
    checks.push(
      check(
        "forbidden",
        "policy",
        hits.length === 0 ? "passed" : "failed",
        hits.length === 0 ? "no forbidden content" : `forbidden content present (${hits.length})`
      )
    )
  }
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    report_id: input.reportId,
    status: aggregate(checks),
    level: "schema_only",
    checks,
    revision: input.revision ?? null,
    verifier_version: TEXT_VERIFIER_VERSION,
    artifact_refs: [],
  }
}

type SchemaNode = Record<string, unknown>

/**
 * A deliberately small JSON Schema subset: type, required, properties, enum,
 * items, minItems, additionalProperties:false. Keywords outside the subset make
 * the check inconclusive instead of silently passing.
 */
const SUPPORTED = new Set([
  "type",
  "required",
  "properties",
  "enum",
  "items",
  "minItems",
  "additionalProperties",
  "description",
  "title",
])

function validateNode(
  value: unknown,
  node: SchemaNode,
  path: string,
  errors: string[],
  unsupported: string[]
): void {
  for (const key of Object.keys(node)) if (!SUPPORTED.has(key)) unsupported.push(`${path}:${key}`)
  if (
    Array.isArray(node.enum) &&
    !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))
  ) {
    errors.push(`${path} is not one of the allowed values`)
  }
  switch (node.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path} must be an object`)
        return
      }
      const record = value as Record<string, unknown>
      for (const field of (node.required as string[] | undefined) ?? []) {
        if (!(field in record)) errors.push(`${path}.${field} is required`)
      }
      const props = (node.properties ?? {}) as Record<string, SchemaNode>
      for (const [field, child] of Object.entries(props)) {
        if (field in record)
          validateNode(record[field], child, `${path}.${field}`, errors, unsupported)
      }
      if (node.additionalProperties === false) {
        for (const field of Object.keys(record))
          if (!(field in props)) errors.push(`${path}.${field} is not allowed`)
      }
      return
    }
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`)
        return
      }
      if (typeof node.minItems === "number" && value.length < node.minItems)
        errors.push(`${path} needs at least ${node.minItems} items`)
      if (node.items)
        value.forEach((item, index) =>
          validateNode(item, node.items as SchemaNode, `${path}[${index}]`, errors, unsupported)
        )
      return
    case "string":
      if (typeof value !== "string") errors.push(`${path} must be a string`)
      return
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${path} must be an integer`)
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        errors.push(`${path} must be a number`)
      return
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be a boolean`)
      return
    case "null":
      if (value !== null) errors.push(`${path} must be null`)
      return
    case undefined:
      return
    default:
      unsupported.push(`${path}:type=${String(node.type)}`)
  }
}

export function validateJsonSubset(
  value: unknown,
  schema: SchemaNode
): { errors: string[]; unsupported: string[] } {
  const errors: string[] = []
  const unsupported: string[] = []
  validateNode(value, schema, "$", errors, unsupported)
  return { errors, unsupported }
}

export function verifySchemaFixture(input: {
  reportId: string
  text: string
  schema: SchemaNode
  expectedFields?: Record<string, unknown>
  revision?: string | null
}): VerificationReport {
  const checks: VerificationCheck[] = []
  const parsed = parseJsonDocument(input.text)
  if (!parsed.ok) {
    checks.push(check("json_parse", "schema", "failed", `invalid JSON: ${parsed.error}`))
  } else {
    const { errors, unsupported } = validateJsonSubset(parsed.value, input.schema)
    if (unsupported.length > 0) {
      checks.push(
        check(
          "schema",
          "schema",
          "inconclusive",
          `unsupported schema keywords: ${unsupported.join(", ")}`
        )
      )
    } else {
      checks.push(
        check(
          "schema",
          "schema",
          errors.length === 0 ? "passed" : "failed",
          errors.length === 0 ? "matches schema" : errors.slice(0, 5).join("; ")
        )
      )
    }
    if (input.expectedFields) {
      const record =
        parsed.value && typeof parsed.value === "object"
          ? (parsed.value as Record<string, unknown>)
          : {}
      const mismatched = Object.entries(input.expectedFields).filter(
        ([field, expected]) => JSON.stringify(record[field]) !== JSON.stringify(expected)
      )
      checks.push(
        check(
          "fixture",
          "fixture",
          mismatched.length === 0 ? "passed" : "failed",
          mismatched.length === 0
            ? "fixture expectations met"
            : `mismatched: ${mismatched.map(([f]) => f).join(", ")}`
        )
      )
    }
  }
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    report_id: input.reportId,
    status: aggregate(checks),
    level: "tool_verified",
    checks,
    revision: input.revision ?? null,
    verifier_version: TEXT_VERIFIER_VERSION,
    artifact_refs: [],
  }
}

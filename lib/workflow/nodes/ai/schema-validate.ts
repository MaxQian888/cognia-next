/**
 * JSON-Schema → zod validation for typed node output (D3).
 *
 * This is a TS twin of the sidecar's `jsonSchemaToZodShape` /
 * `jsonSchemaPropToZod` (`sidecar/builtin-tools/plugin-tools.mjs:164-230`).
 * The sidecar copy validates *tool inputs*; this copy validates an agent
 * turn's *structured output* against a node-declared schema. The two live in
 * different runtimes (Node sidecar vs the app bundle) so they cannot share a
 * module today — flagged for a future shared-source consolidation; do NOT try
 * to merge the build pipelines as part of this slice.
 *
 * Unlike the sidecar twin (which is permissive — it only powers the SDK's
 * autocompletion), this module is used to *gate* output: a violation here
 * drives the auto-fix retry and ultimately the node's errorPolicy.
 */

import { z } from "zod"

/**
 * Map a single JSON-Schema property to a zod type. Unknown types fall back to
 * `z.unknown()`. Optional fields (those not in `required`) get `.optional()`.
 */
export function jsonSchemaPropToZod(prop: unknown, required: boolean): z.ZodTypeAny {
  let zodType: z.ZodTypeAny
  if (!prop || typeof prop !== "object") {
    zodType = z.unknown()
  } else {
    const p = prop as Record<string, unknown>
    switch (p.type) {
      case "string":
        zodType = z.string()
        break
      case "number":
        zodType = z.number()
        break
      case "integer":
        zodType = z.number().int()
        break
      case "boolean":
        zodType = z.boolean()
        break
      case "array": {
        const itemSchema =
          p.items && typeof p.items === "object" ? jsonSchemaPropToZod(p.items, true) : z.unknown()
        zodType = z.array(itemSchema)
        break
      }
      case "object":
        // Nested objects: validate recursively when properties are declared,
        // otherwise accept any record (mirrors the sidecar twin's leniency).
        if (p.properties && typeof p.properties === "object") {
          zodType = z.object(jsonSchemaToZodShape(p))
        } else {
          zodType = z.record(z.string(), z.unknown())
        }
        break
      case "null":
        zodType = z.null()
        break
      default:
        zodType = z.unknown()
    }
    if (typeof p.description === "string" && p.description.length > 0) {
      zodType = zodType.describe(p.description)
    }
  }
  return required ? zodType : zodType.optional()
}

/**
 * Lightweight JSON Schema → zod shape. Keys map to zod schemas (NOT a wrapping
 * `z.object(...)`). For anything that isn't a JSON object schema we return an
 * empty shape.
 */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object") return {}
  const s = schema as Record<string, unknown>
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return {}
  }
  const required = Array.isArray(s.required) ? (s.required as string[]) : []
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(s.properties)) {
    shape[key] = jsonSchemaPropToZod(prop, required.includes(key))
  }
  return shape
}

/** Whether a value is a JSON object schema we can actually validate against. */
export function isValidatableObjectSchema(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === "object" &&
    (schema as Record<string, unknown>).type === "object" &&
    typeof (schema as Record<string, unknown>).properties === "object"
  )
}

export type SchemaValidation = { ok: true } | { ok: false; errors: string[] }

/**
 * Validate a parsed value against a JSON object schema. Non-object schemas (or
 * object schemas with no declared properties) are treated as pass-through —
 * there is nothing to enforce, so the caller should log and accept. Extra keys
 * on the value are tolerated (LLM output often carries them); missing required
 * fields and type mismatches fail.
 */
export function validateAgainstJsonSchema(schema: unknown, value: unknown): SchemaValidation {
  if (!isValidatableObjectSchema(schema)) return { ok: true }
  const shape = jsonSchemaToZodShape(schema)
  const result = z.object(shape).safeParse(value)
  if (result.success) return { ok: true }
  return { ok: false, errors: formatZodIssues(result.error) }
}

/** Flatten a ZodError into stable `path: message` lines. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
    return `${path}: ${issue.message}`
  })
}

/**
 * Build the corrective snippet appended to the re-prompt on the single
 * auto-fix retry. Kept terse — the model already has the schema in its system
 * instruction; this only points at what was wrong.
 */
export function summarizeZodError(errors: string[]): string {
  if (errors.length === 0) return ""
  const lines = errors.map((e) => `  - ${e}`).join("\n")
  return `Your previous reply did not satisfy the required output schema:\n${lines}\nReturn ONLY corrected JSON that satisfies the schema.`
}

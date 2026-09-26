// JSON Schema → zod, for the plugin tool manifest.
//
// A plugin declares each tool's arguments as JSON Schema, but the Claude Agent
// SDK's `tool()` takes a zod raw shape, and the model-visible MCP schema is
// derived from THAT shape, not from the manifest. So anything this converter
// drops is invisible to the model on the Claude Agent SDK rail.

import { z } from "zod"

/** A zod literal value. */
type Literal = string | number | bigint | boolean | null | undefined

/** The JSON Schema keywords the converter reads. */
type JsonSchemaNode = Record<string, unknown>

/** `z.union` needs at least two members; callers check the length first. */
const unionOf = (branches: z.ZodType[]): z.ZodType =>
  z.union(branches as unknown as readonly [z.ZodType, z.ZodType, ...z.ZodType[]])

/**
 * Lightweight JSON Schema → zod shape conversion. The shape object is
 * exactly what `tool()` expects — keys map to zod schemas, NOT a wrapping
 * `z.object(...)`. For anything that isn't a JSON object schema we return
 * an empty shape; the underlying execute call still receives the raw args
 * unchanged because the SDK only uses the shape for validation /
 * autocompletion.
 */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodType> {
  if (!schema || typeof schema !== "object") return {}
  const s = schema as JsonSchemaNode
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return {}
  }
  const required: unknown[] = Array.isArray(s.required) ? s.required : []
  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(s.properties)) {
    shape[key] = jsonSchemaPropToZod(prop, required.includes(key))
  }
  return shape
}

/**
 * Map a single JSON-Schema property to a zod type. Unknown types fall
 * back to `z.unknown()`. Optional fields (those not in `required`) are
 * wrapped with `.optional()`.
 */
export function jsonSchemaPropToZod(prop: unknown, required: boolean): z.ZodType {
  let zodType: z.ZodType
  if (!prop || typeof prop !== "object") {
    zodType = z.unknown()
  } else {
    const p = prop as JsonSchemaNode
    // `enum` / `const` are checked BEFORE `type`: the enum IS the contract, and
    // for several tools it is also the discovery mechanism (dispatch_agent's
    // `subagentId` enumerates the available subagents). Dropping it left the
    // model a bare string on this rail while the ai-sdk rail saw the real
    // constraint — the same tool validated differently per provider.
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      // `null` is a legal enum member and a common one: `enum: ["a","b",null]`
      // is how a schema says "one of these, or explicitly cleared". Filtering it
      // out (rather than mapping it to `z.null()`) made this rail reject a value
      // the schema declares, and left `enum: [null]` with no members at all.
      const members: unknown[] = p.enum
      const literals = members.filter((v) => v !== null && v !== undefined)
      const hasNull = members.includes(null)
      if (!hasNull && literals.length > 0 && literals.every((v) => typeof v === "string")) {
        zodType = z.enum(literals as [string, ...string[]])
      } else {
        const branches: z.ZodType[] = [
          ...literals.map((v) => z.literal(v as Literal)),
          ...(hasNull ? [z.null()] : []),
        ]
        // A single member is a literal, not a union: `z.union` needs two, and
        // duplicating the member to satisfy it only obscured the empty case.
        zodType =
          branches.length === 1
            ? branches[0]!
            : branches.length > 1
              ? unionOf(branches)
              : z.unknown()
      }
    } else if (p.const !== undefined) {
      zodType = z.literal(p.const as Literal)
    } else if (Array.isArray(p.oneOf) || Array.isArray(p.anyOf)) {
      // A discriminated union renders as `oneOf`. Without this branch it fell
      // to `z.unknown()` below, and because the model-visible MCP schema is
      // derived from THIS zod shape (not from the manifest JSON Schema), every
      // union-typed argument reached the model as an opaque blob — which is
      // exactly how computer-use's whole action vocabulary went missing.
      const variants = (p.oneOf ?? p.anyOf) as unknown[]
      const branches = variants.map((v) => jsonSchemaPropToZod(v, true))
      zodType =
        branches.length === 1 ? branches[0]! : branches.length > 1 ? unionOf(branches) : z.unknown()
    } else {
      switch (p.type) {
        case "string": {
          let s = z.string()
          if (typeof p.minLength === "number") s = s.min(p.minLength)
          if (typeof p.maxLength === "number") s = s.max(p.maxLength)
          if (typeof p.pattern === "string") {
            try {
              s = s.regex(new RegExp(p.pattern))
            } catch {
              /* an unsupported pattern must not brick the tool */
            }
          }
          zodType = s
          break
        }
        case "number":
        case "integer": {
          let n = p.type === "integer" ? z.number().int() : z.number()
          if (typeof p.minimum === "number") n = n.min(p.minimum)
          if (typeof p.maximum === "number") n = n.max(p.maximum)
          if (typeof p.exclusiveMinimum === "number") n = n.gt(p.exclusiveMinimum)
          if (typeof p.exclusiveMaximum === "number") n = n.lt(p.exclusiveMaximum)
          zodType = n
          break
        }
        case "boolean":
          zodType = z.boolean()
          break
        case "array": {
          const itemSchema =
            p.items && typeof p.items === "object"
              ? jsonSchemaPropToZod(p.items, true)
              : z.unknown()
          let a = z.array(itemSchema)
          if (typeof p.minItems === "number") a = a.min(p.minItems)
          if (typeof p.maxItems === "number") a = a.max(p.maxItems)
          zodType = a
          break
        }
        case "object": {
          // Recurse into nested `properties`/`required` instead of collapsing
          // the whole object to an opaque record. `working_set.entry` carries
          // three enums, a `required` list and `refs.maxItems` that all
          // vanished under the old `z.record(z.string(), z.unknown())`.
          if (p.properties && typeof p.properties === "object") {
            const nestedRequired: unknown[] = Array.isArray(p.required) ? p.required : []
            const nestedShape: Record<string, z.ZodType> = {}
            for (const [k, v] of Object.entries(p.properties)) {
              nestedShape[k] = jsonSchemaPropToZod(v, nestedRequired.includes(k))
            }
            const obj = z.object(nestedShape)
            // Only close the object when the schema says so; JSON Schema's
            // default is open, and tightening it would reject valid calls.
            zodType = p.additionalProperties === false ? obj.strict() : obj.passthrough()
          } else {
            zodType = z.record(z.string(), z.unknown())
          }
          break
        }
        case "null":
          zodType = z.null()
          break
        default:
          zodType = z.unknown()
      }
    }
    if (typeof p.description === "string" && p.description.length > 0) {
      zodType = zodType.describe(p.description)
    }
    // `default` implies the field is optional to the caller; apply it last so
    // it wraps whatever constraint was built above.
    if (p.default !== undefined && !required) {
      return zodType.optional().default(p.default)
    }
  }
  return required ? zodType : zodType.optional()
}

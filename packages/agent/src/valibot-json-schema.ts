import type * as v from "valibot"

import type { JsonSchema } from "./types"

/**
 * The schema this converter met and does not know how to express.
 *
 * Refusing is the point. A converter that silently dropped an unsupported
 * constraint would hand the model a contract weaker than the one the client
 * validates against, and the mismatch would only show up as a tool call the
 * host rejects at runtime. Callers who need something outside the supported
 * subset pass a raw JSON Schema instead — typed `unknown`, so the loss of
 * inference is visible rather than assumed.
 */
export class UnsupportedSchemaError extends Error {
  readonly code = "unsupported_schema" as const
  readonly schemaType: string
  readonly path: string

  constructor(schemaType: string, path: string) {
    super(
      `cannot convert valibot schema "${schemaType}"${path ? ` at ${path}` : ""} to JSON Schema. ` +
        "Pass a raw JSON Schema for this tool instead."
    )
    this.name = "UnsupportedSchemaError"
    this.schemaType = schemaType
    this.path = path
  }
}

type AnySchema = {
  kind: string
  type: string
  pipe?: readonly { kind: string; type: string; requirement?: unknown; description?: unknown }[]
  wrapped?: AnySchema
  item?: AnySchema
  entries?: Record<string, AnySchema>
  options?: readonly unknown[]
  literal?: unknown
  key?: AnySchema
  value?: AnySchema
  default?: unknown
}

/** Validation and metadata actions this converter understands. */
function applyActions(schema: JsonSchema, source: AnySchema, path: string): JsonSchema {
  if (!source.pipe) return schema
  const out = { ...schema }
  for (const action of source.pipe) {
    if (action.kind === "schema") continue
    switch (action.type) {
      case "description":
        out.description = action.description
        break
      case "title":
        out.title = action.description
        break
      case "min_length":
        if (out.type === "array") out.minItems = action.requirement
        else out.minLength = action.requirement
        break
      case "max_length":
        if (out.type === "array") out.maxItems = action.requirement
        else out.maxLength = action.requirement
        break
      case "length":
        if (out.type === "array") {
          out.minItems = action.requirement
          out.maxItems = action.requirement
        } else {
          out.minLength = action.requirement
          out.maxLength = action.requirement
        }
        break
      case "min_value":
        out.minimum = action.requirement
        break
      case "max_value":
        out.maximum = action.requirement
        break
      case "multiple_of":
        out.multipleOf = action.requirement
        break
      case "integer":
        out.type = "integer"
        break
      case "regex":
        out.pattern = String(action.requirement).replace(/^\/|\/[a-z]*$/g, "")
        break
      case "email":
        out.format = "email"
        break
      case "url":
        out.format = "uri"
        break
      case "uuid":
        out.format = "uuid"
        break
      case "iso_date":
        out.format = "date"
        break
      case "iso_timestamp":
        out.format = "date-time"
        break
      default:
        throw new UnsupportedSchemaError(`${source.type}/${action.type}`, path)
    }
  }
  return out
}

function convertNode(source: AnySchema, path: string): JsonSchema {
  switch (source.type) {
    case "string":
      return applyActions({ type: "string" }, source, path)
    case "number":
    case "bigint":
      return applyActions({ type: "number" }, source, path)
    case "boolean":
      return applyActions({ type: "boolean" }, source, path)
    case "null":
      return applyActions({ type: "null" }, source, path)
    case "any":
    case "unknown":
      return applyActions({}, source, path)
    case "literal": {
      return applyActions({ const: source.literal }, source, path)
    }
    case "picklist":
    case "enum":
      return applyActions({ enum: [...(source.options ?? [])] }, source, path)
    case "array": {
      if (!source.item) throw new UnsupportedSchemaError("array", path)
      return applyActions(
        { type: "array", items: convertNode(source.item, `${path}[]`) },
        source,
        path
      )
    }
    case "object":
    case "loose_object":
    case "strict_object": {
      const entries = source.entries ?? {}
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, entry] of Object.entries(entries)) {
        const child = path ? `${path}.${key}` : key
        properties[key] = convertNode(entry, child)
        if (!isOptional(entry)) required.push(key)
      }
      return applyActions(
        {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: source.type === "loose_object",
        },
        source,
        path
      )
    }
    case "record": {
      if (!source.value) throw new UnsupportedSchemaError("record", path)
      return applyActions(
        { type: "object", additionalProperties: convertNode(source.value, `${path}.*`) },
        source,
        path
      )
    }
    case "union":
    case "variant": {
      const options = (source.options ?? []) as AnySchema[]
      if (options.length === 0) throw new UnsupportedSchemaError(source.type, path)
      return applyActions(
        { anyOf: options.map((option, index) => convertNode(option, `${path}|${index}`)) },
        source,
        path
      )
    }
    case "optional":
    case "nullish":
    case "exact_optional": {
      if (!source.wrapped) throw new UnsupportedSchemaError(source.type, path)
      return convertNode(source.wrapped, path)
    }
    case "nullable": {
      if (!source.wrapped) throw new UnsupportedSchemaError("nullable", path)
      return { anyOf: [convertNode(source.wrapped, path), { type: "null" }] }
    }
    default:
      throw new UnsupportedSchemaError(source.type, path)
  }
}

function isOptional(entry: AnySchema): boolean {
  return entry.type === "optional" || entry.type === "nullish" || entry.type === "exact_optional"
}

/**
 * Convert a Valibot schema to JSON Schema, or refuse.
 *
 * Supported: string, number, bigint, boolean, null, literal, picklist/enum,
 * array, object (plus loose/strict), record, union/variant, optional, nullish,
 * nullable, and the validation actions listed in `applyActions`.
 */
export function valibotToJsonSchema(schema: v.GenericSchema): JsonSchema {
  const converted = convertNode(schema as unknown as AnySchema, "")
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...converted }
}

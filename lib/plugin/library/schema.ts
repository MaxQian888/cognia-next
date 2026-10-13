import { Validator, type Schema } from "jsonschema"
// Data only: the interpreted validator never invokes Ajv's code generator.
import draft07 from "ajv/dist/refs/json-schema-draft-07.json"
import type { PluginLibrarySchema } from "@/types/plugin/plugin-library"

const SCHEMA_BYTES = 256 * 1024
const BASE_URI = "https://cognia.invalid/library-schema"
const SCHEMA_KEYWORDS = new Set(Object.keys(draft07.properties))
const SCHEMA_MAPS = ["properties", "patternProperties", "definitions"]
const SCHEMA_CHILDREN = [
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]

/** Reject lossy serialization, accessors and cycles before copying a JSON boundary. */
export function cloneLibraryJson<T>(value: T, maxBytes: number): T {
  let bytes = 0
  const active = new Set<object>()
  const encoder = new TextEncoder()
  const charge = (text: string) => {
    bytes += encoder.encode(text).byteLength
    if (bytes > maxBytes) throw new RangeError("Library JSON payload exceeds the byte limit")
  }
  const copy = (input: unknown, depth: number): unknown => {
    if (depth > 128) throw new RangeError("Library JSON payload exceeds the nesting limit")
    if (input === null || typeof input === "boolean" || typeof input === "string") {
      charge(JSON.stringify(input))
      return input
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      charge(JSON.stringify(input))
      return input
    }
    if (typeof input !== "object" || input === null)
      throw new TypeError("Library payload must contain only JSON values")
    if (active.has(input)) throw new TypeError("Library JSON payload contains a cycle")
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    ) {
      throw new TypeError("Library JSON objects must be plain objects")
    }
    active.add(input)
    const array = Array.isArray(input)
    const output: Record<string, unknown> | unknown[] = array ? [] : {}
    const keys = Reflect.ownKeys(input).filter((key) => !(array && key === "length"))
    if (array && keys.length !== input.length)
      throw new TypeError("Library JSON arrays cannot be sparse or have custom properties")
    charge(array ? "[]" : "{}")
    keys.forEach((key, index) => {
      if (typeof key !== "string" || (array && key !== String(index)))
        throw new TypeError("Library JSON values cannot contain symbol or custom array properties")
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new TypeError("Library JSON values cannot contain accessors or hidden properties")
      if (index) charge(",")
      if (!array) charge(`${JSON.stringify(key)}:`)
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    })
    active.delete(input)
    return output
  }
  return copy(value, 0) as T
}

function prepareSchema(schema: unknown): { validator: Validator; schema: Schema } {
  const clean = cloneLibraryJson(schema, SCHEMA_BYTES)
  const meta = new Validator().validate(clean, draft07 as unknown as Schema)
  if (!meta.valid)
    throw new TypeError(
      `Invalid draft-07 schema: ${meta.errors[0].property} ${meta.errors[0].name}`
    )
  const resources = new Map<string, unknown>([[BASE_URI, clean]])
  const schemaObjects = new Set<object>()
  const references: Array<{ uri: string }> = []
  const walk = (node: unknown, base: string) => {
    if (typeof node === "boolean") return
    const current = node as Record<string, unknown>
    schemaObjects.add(current)
    for (const keyword of Object.keys(current)) {
      if (!SCHEMA_KEYWORDS.has(keyword))
        throw new TypeError(`Unsupported draft-07 keyword: ${keyword}`)
    }
    if (
      current.$schema !== undefined &&
      !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(String(current.$schema))
    ) {
      throw new TypeError("Library schemas require the draft-07 dialect")
    }
    if (typeof current.$id === "string") {
      base = new URL(current.$id, base).href
      if (resources.has(base) && resources.get(base) !== node)
        throw new TypeError("Duplicate library schema identifier")
      resources.set(base, node)
    }
    if (typeof current.$ref === "string") references.push({ uri: new URL(current.$ref, base).href })
    if (typeof current.pattern === "string") new RegExp(current.pattern)
    for (const key of SCHEMA_MAPS) {
      const map = current[key] as Record<string, unknown> | undefined
      if (map) {
        // The interpreter checks property maps by lookup. Inherited keys must
        // not bypass additionalProperties: false (e.g. `constructor`).
        Object.setPrototypeOf(map, null)
        for (const [name, child] of Object.entries(map)) {
          if (key === "patternProperties") new RegExp(name)
          walk(child, base)
        }
      }
    }
    for (const key of SCHEMA_CHILDREN) if (current[key] !== undefined) walk(current[key], base)
    for (const key of ["allOf", "anyOf", "oneOf", "items"]) {
      const children = current[key]
      if (Array.isArray(children)) children.forEach((child) => walk(child, base))
      else if (children !== undefined) walk(children, base)
    }
    for (const child of Object.values((current.dependencies ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(child)) walk(child, base)
    }
  }
  walk(clean, BASE_URI)
  for (const { uri } of references) {
    if (resources.has(uri)) continue
    const url = new URL(uri)
    const fragment = decodeURIComponent(url.hash.slice(1))
    url.hash = ""
    let target = resources.get(url.href)
    if (fragment && !fragment.startsWith("/"))
      throw new TypeError("Unresolved library schema reference")
    for (const part of fragment ? fragment.slice(1).split("/") : []) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~")
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new TypeError("Unresolved library schema reference")
      target = (target as Record<string, unknown>)[key]
    }
    if (
      typeof target !== "boolean" &&
      (target === null || typeof target !== "object" || !schemaObjects.has(target))
    ) {
      throw new TypeError("Unresolved or non-schema library reference")
    }
  }
  const validator = new Validator()
  for (const [uri, resource] of resources) validator.schemas[uri] = resource as Schema
  return { validator, schema: clean as Schema }
}

/** Admission checks all branches, including unused definitions and remote references. */
export function validateLibrarySchema(schema: unknown): string | null {
  try {
    prepareSchema(schema)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid library schema"
  }
}

/** Does not coerce values, apply defaults, mutate payloads, or include payloads in errors. */
export function validateLibraryValue(schema: PluginLibrarySchema, value: unknown): string | null {
  try {
    const prepared = prepareSchema(schema)
    const clean = cloneLibraryJson(value, Number.MAX_SAFE_INTEGER)
    const result = prepared.validator.validate(clean, prepared.schema, {
      base: BASE_URI,
      required: true,
    })
    return result.valid
      ? null
      : `Library schema violation at ${result.errors[0].property} (${result.errors[0].name})`
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid library value"
  }
}

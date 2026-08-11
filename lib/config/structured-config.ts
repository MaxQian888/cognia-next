import { parseDocument, stringify } from "yaml"

export type StructuredConfigFormat = "json" | "yaml"

export const MAX_STRUCTURED_CONFIG_BYTES = 1024 * 1024

export function parseStructuredConfig<T>(
  source: string,
  format: StructuredConfigFormat,
  validate: (value: unknown) => T
): T {
  if (new TextEncoder().encode(source).byteLength > MAX_STRUCTURED_CONFIG_BYTES) {
    throw new Error("Configuration file is too large")
  }

  const parsed = format === "json" ? JSON.parse(source) : parseYamlWithoutAliases(source)
  return validate(parsed)
}

export function serializeStructuredConfig<T>(value: T, format: StructuredConfigFormat): string {
  return format === "json" ? `${JSON.stringify(value, null, 2)}\n` : stringify(value)
}

function parseYamlWithoutAliases(source: string): unknown {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) throw document.errors[0]
  try {
    return document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    throw new Error(
      `YAML aliases are not allowed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

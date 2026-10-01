/**
 * Which parts of a plugin's config are secrets.
 *
 * A `configSchema` property with `secret: true` is only valid at the top level
 * of `configSchema.properties` (enforced by `validation.ts`), so a secret is
 * always a top-level key. Its value is currently stored with the rest of the
 * plugin's config (see the note on `SecretInput` in `plugin-config-form.tsx`),
 * which is why anything that copies config elsewhere — a cogset, a cogpack —
 * has to strip secrets itself and put the current ones back when it applies.
 */

type ConfigSchemaLike = { properties?: Record<string, unknown> } | null | undefined

function readSchema(manifest: unknown): ConfigSchemaLike {
  if (!manifest || typeof manifest !== "object") return undefined
  const schema = (manifest as { configSchema?: unknown }).configSchema
  return schema && typeof schema === "object" ? (schema as ConfigSchemaLike) : undefined
}

/** Top-level config keys the manifest declares `secret: true`, sorted. */
export function listSecretConfigFields(manifest: unknown): string[] {
  const properties = readSchema(manifest)?.properties
  if (!properties || typeof properties !== "object") return []
  return Object.entries(properties)
    .filter(
      ([, property]) =>
        !!property &&
        typeof property === "object" &&
        (property as { secret?: unknown }).secret === true
    )
    .map(([key]) => key)
    .sort()
}

/** `config` without its secret fields. Never mutates the input. */
export function stripSecretConfig(
  config: Record<string, unknown> | undefined,
  manifest: unknown
): Record<string, unknown> {
  if (!config) return {}
  const secrets = new Set(listSecretConfigFields(manifest))
  return Object.fromEntries(Object.entries(config).filter(([key]) => !secrets.has(key)))
}

/**
 * `next` with the secret fields taken from `current`, so applying copied
 * config never replaces or erases a secret the user already entered.
 */
export function mergeKeepingSecrets(
  next: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  manifest: unknown
): Record<string, unknown> {
  const secrets = listSecretConfigFields(manifest)
  const merged = stripSecretConfig(next, manifest)
  for (const key of secrets) {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) merged[key] = current[key]
  }
  return merged
}

/** Secret fields the manifest declares that `config` has no non-empty value for. */
export function missingSecretFields(
  config: Record<string, unknown> | undefined,
  manifest: unknown
): string[] {
  return listSecretConfigFields(manifest).filter((key) => {
    const value = config?.[key]
    return typeof value !== "string" || value.length === 0
  })
}

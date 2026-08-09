import type { PluginManifest } from "@/types/plugin"
import { PLUGIN_MANIFEST_CONTRIBUTIONS } from "@/packages/plugin-sdk/src/contracts/catalog"

export interface PluginManifestParityIssue {
  field: string
  packaged: unknown
  module: unknown
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "function" || value === undefined) return undefined
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
        .filter(([, entry]) => entry !== undefined)
    )
  }
  return value
}

function comparable(value: unknown): string | undefined {
  return JSON.stringify(canonicalize(value))
}

/**
 * Compare the package manifest (the install-time source of truth) with the
 * module-exported manifest for every declarative contribution field.
 */
export function findPluginManifestParityIssues(
  packaged: PluginManifest,
  moduleManifest: PluginManifest | undefined
): PluginManifestParityIssue[] {
  if (!moduleManifest) return []
  const issues: PluginManifestParityIssue[] = []
  if (moduleManifest.id && moduleManifest.id !== packaged.id) {
    issues.push({ field: "id", packaged: packaged.id, module: moduleManifest.id })
  }
  for (const contract of PLUGIN_MANIFEST_CONTRIBUTIONS) {
    const field = contract.field as keyof PluginManifest
    const packagedValue = packaged[field]
    const moduleValue = moduleManifest[field]
    if (comparable(packagedValue) !== comparable(moduleValue)) {
      issues.push({ field: String(field), packaged: packagedValue, module: moduleValue })
    }
  }
  return issues
}

export class PluginManifestParityError extends Error {
  readonly pluginId: string
  readonly fields: string[]

  constructor(pluginId: string, issues: PluginManifestParityIssue[]) {
    const fields = issues.map((issue) => issue.field)
    super(
      `Packaged plugin manifest drift for "${pluginId}" in: ${fields.join(", ")}. ` +
        "Materialize these contributions into plugin.json before publishing."
    )
    this.name = "PluginManifestParityError"
    this.pluginId = pluginId
    this.fields = fields
  }
}

/** Fail loudly before activation when an installed module would lose contributions. */
export function assertPluginManifestParity(
  packaged: PluginManifest,
  moduleManifest: PluginManifest | undefined
): void {
  const issues = findPluginManifestParityIssues(packaged, moduleManifest)
  if (issues.length > 0) throw new PluginManifestParityError(packaged.id, issues)
}

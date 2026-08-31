export type SelectionToolbarMode = "off" | "automatic" | "manual"

export interface SelectionActionLayout {
  ordered: string[]
  hidden: string[]
  pinned: string[]
}

const MODES: readonly SelectionToolbarMode[] = ["off", "automatic", "manual"]

export function migrateSelectionToolbarMode(
  mode: SelectionToolbarMode | undefined,
  legacyEnabled: boolean | undefined
): SelectionToolbarMode {
  if (MODES.includes(mode as SelectionToolbarMode)) return mode as SelectionToolbarMode
  return legacyEnabled ? "automatic" : "off"
}

function normalizeHostnameRule(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || /\s/.test(trimmed)) return undefined
  const wildcard = trimmed.startsWith("*.")
  const raw = wildcard ? trimmed.slice(2) : trimmed

  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    if (!parsed.hostname || parsed.port) return undefined
    return `${wildcard ? "*." : ""}${parsed.hostname.toLowerCase()}`
  } catch {
    return undefined
  }
}

export function normalizeHostnameRules(values: readonly string[]): string[] {
  const rules = new Set<string>()
  for (const value of values) {
    const normalized = normalizeHostnameRule(value)
    if (normalized) rules.add(normalized)
  }
  return [...rules]
}

function normalizeActionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
}

export function normalizeSelectionActionLayout(value: unknown): SelectionActionLayout {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    ordered: normalizeActionIds(record.ordered),
    hidden: normalizeActionIds(record.hidden),
    pinned: normalizeActionIds(record.pinned),
  }
}

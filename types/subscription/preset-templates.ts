// Preset templates — a pure projection of the Provider System catalog
// (`types/provider/built-in-provider-catalog.ts`) into ready-to-instantiate
// subscription presets. No duplicate endpoint table: when the catalog grows,
// the template list grows for free.
//
// Subscription presets only apply to the OAuth providers that support them —
// Anthropic (anthropic-wire relays) and Codex (OpenAI-compatible relays).
// OpenCode manages its own endpoints in auth.json and rejects presets.

import {
  getBuiltInProviderCatalog,
  type BuiltInProviderCatalogEntry,
  type BuiltInProviderFamily,
} from "@/types/provider/built-in-provider-catalog"

/** A preset the user can instantiate with one click (baseUrl pre-filled). */
export interface PresetTemplate {
  /** Catalog entry id this template derives from, or `"custom"` for the blank. */
  templateId: string
  /** Display name ("AWS Bedrock", "OpenRouter", "Custom endpoint"). */
  label: string
  /** Pre-filled base URL. Empty string for the blank "Custom" template. */
  baseUrl: string
  /** Optional docs link surfaced next to the template. */
  docsUrl?: string
  /** Which subscription provider this template targets. */
  provider: "anthropic" | "codex"
}

/** Which catalog families map to which subscription provider's templates. */
const FAMILIES_BY_PROVIDER: Record<"anthropic" | "codex", readonly BuiltInProviderFamily[]> = {
  anthropic: ["anthropic-native"],
  codex: ["openai-compatible", "openrouter"],
}

/** Concrete endpoint for a catalog entry, if it carries one. */
function baseUrlOf(entry: BuiltInProviderCatalogEntry): string | undefined {
  const direct = entry.defaultBaseURL?.trim()
  if (direct) return direct
  const compat = entry.compatibility?.baseURLs?.find((u) => u.trim().length > 0)
  return compat?.trim()
}

/** The blank "Custom" template — always offered so users can type any URL. */
function customTemplate(provider: "anthropic" | "codex"): PresetTemplate {
  return { templateId: "custom", label: "Custom", baseUrl: "", provider }
}

/**
 * Build the preset templates offered for a subscription provider. The blank
 * "Custom" template is always first; the rest are catalog relays in the
 * matching protocol family that carry a concrete base URL.
 */
export function buildPresetTemplates(provider: "anthropic" | "codex"): PresetTemplate[] {
  const families = FAMILIES_BY_PROVIDER[provider]
  const fromCatalog = getBuiltInProviderCatalog()
    .filter(
      (e): e is BuiltInProviderCatalogEntry & { family: BuiltInProviderFamily } =>
        e.family !== undefined && families.includes(e.family)
    )
    .map((e) => {
      const baseUrl = baseUrlOf(e)
      if (!baseUrl) return undefined
      const template: PresetTemplate = {
        templateId: e.id,
        label: e.name,
        baseUrl,
        provider,
      }
      if (e.docsUrl) template.docsUrl = e.docsUrl
      return template
    })
    .filter((t): t is PresetTemplate => t !== undefined)
    .sort((a, b) => a.label.localeCompare(b.label))

  return [customTemplate(provider), ...fromCatalog]
}

/** Look up a single template by id (for instantiate-from-template flows). */
export function findPresetTemplate(
  provider: "anthropic" | "codex",
  templateId: string
): PresetTemplate | undefined {
  return buildPresetTemplates(provider).find((t) => t.templateId === templateId)
}

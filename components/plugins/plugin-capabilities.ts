// Single source of truth for the plugin capability categories shown in the
// Library capability rail (`plugin-category-sidebar.tsx`) and the filter sheet
// (`dialogs/plugin-filter-sheet.tsx`). Keeping one list prevents the two
// surfaces from drifting (they used to hardcode 14 vs 18 divergent entries).
//
// `i18nKey` is the suffix under the `plugins.categorySidebar.capability.*`
// namespace; `id` is the value matched against `PluginRow.capabilities`.

import type { ComponentType } from "react"
import { CANONICAL_PLUGIN_CAPABILITIES } from "@cognia/plugin-contract/contracts/catalog"
import {
  WrenchIcon,
  PuzzleIcon,
  BotIcon,
  PaletteIcon,
  CommandIcon,
  ZapIcon,
  GraduationCapIcon,
  ImageIcon,
  PencilRulerIcon,
  LayoutTemplateIcon,
  ServerCogIcon,
  PlugIcon,
  CpuIcon,
  CalendarClockIcon,
  PackageIcon,
  CodeIcon,
} from "lucide-react"

export interface PluginCapabilityMeta {
  /** Matched against `PluginRow.capabilities`. */
  id: string
  /** Suffix under the `plugins.categorySidebar.capability.*` i18n namespace. */
  i18nKey: string
  icon: ComponentType<{ className?: string }>
}

export const CAPABILITY_META: readonly PluginCapabilityMeta[] = [
  { id: "tools", i18nKey: "tools", icon: WrenchIcon },
  { id: "components", i18nKey: "components", icon: PuzzleIcon },
  { id: "modes", i18nKey: "modes", icon: BotIcon },
  { id: "bot", i18nKey: "bot", icon: BotIcon },
  { id: "themes", i18nKey: "themes", icon: PaletteIcon },
  { id: "commands", i18nKey: "commands", icon: CommandIcon },
  { id: "hooks", i18nKey: "hooks", icon: ZapIcon },
  { id: "skills", i18nKey: "skills", icon: GraduationCapIcon },
  { id: "media", i18nKey: "media", icon: ImageIcon },
  { id: "canvas", i18nKey: "canvas", icon: PencilRulerIcon },
  { id: "a2ui", i18nKey: "a2ui", icon: LayoutTemplateIcon },
  { id: "ai-provider", i18nKey: "ai-provider", icon: ServerCogIcon },
  { id: "providers", i18nKey: "providers", icon: PlugIcon },
  { id: "processors", i18nKey: "processors", icon: CpuIcon },
  { id: "scheduler", i18nKey: "scheduler", icon: CalendarClockIcon },
  { id: "exporters", i18nKey: "exporters", icon: PackageIcon },
  { id: "importers", i18nKey: "importers", icon: PackageIcon },
  { id: "python", i18nKey: "python", icon: CodeIcon },
  { id: "external-agent-preset", i18nKey: "agentPresets", icon: BotIcon },
]

/** Capability ids only, in display order. */
export const CAPABILITY_IDS: readonly string[] = CAPABILITY_META.map((c) => c.id)

const CANONICAL_CAPABILITY_IDS: ReadonlySet<string> = new Set(CANONICAL_PLUGIN_CAPABILITIES)

/**
 * The i18n key, under `plugins.categorySidebar`, that names a capability.
 *
 * A curated capability uses its rail label (`capability.<i18nKey>`). Every
 * other capability the SDK catalog defines has a name under
 * `capabilityName.<id>`: the rail's "Other" group, the detail pane and the
 * filter sheet used to print those as raw ids (`agent-team-template`),
 * truncated in a 13rem rail. `null` only for an id the catalog does not know
 * (a newer plugin on an older host), which callers print as stored.
 */
export function capabilityLabelKey(id: string): string | null {
  const curated = CAPABILITY_META.find((meta) => meta.id === id)
  if (curated) return `capability.${curated.i18nKey}`
  return CANONICAL_CAPABILITY_IDS.has(id) ? `capabilityName.${id}` : null
}

/**
 * Resolve a capability's display name with a `plugins.categorySidebar`
 * translator, falling back to the raw id for an unknown capability.
 */
export function capabilityLabel(
  t: (key: never) => string,
  id: string
): { label: string; known: boolean } {
  const key = capabilityLabelKey(id)
  return key ? { label: t(key as never), known: true } : { label: id, known: false }
}

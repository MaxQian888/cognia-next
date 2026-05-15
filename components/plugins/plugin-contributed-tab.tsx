"use client"

/**
 * PluginContributedTab — enumerates every runtime contribution a plugin has
 * registered against the host. The manifest-side capabilities/contributes
 * keys are surfaced separately in the General tab; this view goes one
 * level deeper and reads each contribution registry by `pluginId` so users
 * can see "this plugin registered MCP preset X, skill Y, workflow node Z,
 * …" rather than just the manifest declaration keys.
 *
 * Reads are synchronous snapshots from the in-memory registries:
 *   - PluginRegistry (tools / a2ui components / a2ui templates / modes /
 *     commands)         — `lib/plugin/core/registry.ts`
 *   - Theme registry   — `lib/theme/theme-registry.ts`
 *   - MCP server presets / Skills / Native Anthropic tools —
 *     `lib/plugin/registries/*-registry.ts`
 *   - External agent presets — `lib/ai/agent/external/presets.ts`
 *   - Connector adapters — `lib/plugin/connectors-bridge.ts`
 *   - Workflow nodes + triggers — `lib/workflow/nodes/catalog.ts`
 *
 * Categories with zero contributions are hidden so the panel collapses to
 * only what is relevant for this specific plugin. When no category is
 * non-empty the tab shows a single empty-state card.
 */

import { useTranslations } from "next-intl"
import { useSyncExternalStore } from "react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { getPluginManager } from "@/lib/plugin/core/manager"
import {
  listPluginThemes,
  subscribeThemeRegistry,
  type PluginTheme,
} from "@/lib/theme/theme-registry"
import { listMcpServerPresetEntries } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listSkillEntries } from "@/lib/plugin/registries/skill-registry"
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { listDynamicPresetEntries } from "@/lib/ai/agent/external/presets"
import { getPluginAdapterIds } from "@/lib/plugin/connectors-bridge"
import {
  getPluginCatalogSnapshot,
  subscribePluginCatalog,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"

interface Props {
  pluginId: string
}

type ContributionLabelKey =
  | "tools"
  | "modes"
  | "commands"
  | "a2uiComponents"
  | "a2uiTemplates"
  | "themes"
  | "mcpServerPresets"
  | "skills"
  | "nativeAnthropicTools"
  | "externalAgentPresets"
  | "connectors"
  | "workflowNodes"
  | "workflowTriggers"

interface Section {
  key: ContributionLabelKey
  items: string[]
}

/**
 * Theme registry exposes a notify-based subscription. We mirror it through
 * `useSyncExternalStore` so theme registrations flow into the tab without a
 * page reload. The other registries don't yet have subscription primitives —
 * the tab re-reads them on every render, which is cheap since each registry
 * is an in-memory Map.
 */
function useThemes(pluginId: string): PluginTheme[] {
  const themes = useSyncExternalStore(
    subscribeThemeRegistry,
    listPluginThemes,
    () => [] as PluginTheme[]
  )
  return themes.filter((t) => t.pluginId === pluginId)
}

/** Plugin-contributed workflow nodes / triggers come from the catalog. */
function usePluginCatalogEntries(pluginId: string): NodeCatalogEntry[] {
  const entries = useSyncExternalStore(
    subscribePluginCatalog,
    getPluginCatalogSnapshot,
    () => [] as readonly NodeCatalogEntry[]
  )
  return entries.filter((e) => e.pluginId === pluginId)
}

export function PluginContributedTab({ pluginId }: Props) {
  const t = useTranslations("plugins.detail.contributed")
  const manager = getPluginManager()
  const registry = manager.getRegistry()

  const themes = useThemes(pluginId)
  const catalog = usePluginCatalogEntries(pluginId)

  // Workflow catalog entries split by category so triggers and nodes get
  // their own cards.
  const triggerEntries = catalog.filter((e) => e.category === "trigger")
  const nodeEntries = catalog.filter((e) => e.category !== "trigger")

  // Build the section list — order matters for the rendered grid.
  const sections: Section[] = [
    {
      key: "tools",
      items: registry.getToolsByPlugin(pluginId).map((tool) => tool.name),
    },
    {
      key: "modes",
      items: registry.getModesByPlugin(pluginId).map((mode) => mode.name ?? mode.id),
    },
    {
      key: "commands",
      items: registry.getCommandsByPlugin(pluginId).map((cmd) => cmd.id),
    },
    {
      key: "a2uiComponents",
      items: registry.getComponentsByPlugin(pluginId).map((cmp) => cmp.type),
    },
    {
      key: "a2uiTemplates",
      items: registry.getTemplatesByPlugin(pluginId).map((tpl) => tpl.id),
    },
    {
      key: "themes",
      items: themes.map((th) => th.name || th.id),
    },
    {
      key: "mcpServerPresets",
      items: listMcpServerPresetEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => e.id),
    },
    {
      key: "skills",
      items: listSkillEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => e.id),
    },
    {
      key: "nativeAnthropicTools",
      items: listNativeAnthropicToolEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => e.id),
    },
    {
      key: "externalAgentPresets",
      items: listDynamicPresetEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => e.id),
    },
    {
      key: "connectors",
      items: [...getPluginAdapterIds(pluginId)],
    },
    {
      key: "workflowNodes",
      items: nodeEntries.map((e) => e.label || e.kind),
    },
    {
      key: "workflowTriggers",
      items: triggerEntries.map((e) => e.label || e.kind),
    },
  ]

  const populated = sections.filter((s) => s.items.length > 0)

  if (populated.length === 0) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="plugin-contributed-tab">
      {populated.map((section) => (
        <ContributionCard key={section.key} labelKey={section.key} items={section.items} />
      ))}
    </div>
  )
}

interface ContributionCardProps {
  labelKey: ContributionLabelKey
  items: string[]
}

function ContributionCard({ labelKey, items }: ContributionCardProps) {
  const t = useTranslations("plugins.detail.contributed")
  return (
    <Card className="p-3 space-y-2" data-testid={`contributed-${labelKey}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{t(labelKey)}</h4>
        <Badge variant="outline" className="text-xs">
          {t("countBadge", { count: items.length })}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Badge key={item} variant="secondary" className="font-mono text-xs">
            {item}
          </Badge>
        ))}
      </div>
    </Card>
  )
}

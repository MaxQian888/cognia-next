"use client"

/**
 * PluginContributedTab — enumerates every runtime contribution a plugin has
 * registered against the host. The manifest-side capabilities/contributes
 * keys are surfaced separately in the General tab; this view goes one
 * level deeper and reads each contribution registry by `pluginId` so users
 * can see "this plugin registered MCP preset X, skill Y, workflow node Z,
 * …" rather than just the manifest declaration keys.
 *
 * Reads are snapshots from the in-memory registries:
 *   - PluginRegistry (tools / a2ui components / a2ui templates / modes /
 *     commands)         — `lib/plugin/core/registry.ts`
 *   - Command registry (titled commands) — `lib/plugin/commands/registry.ts`
 *   - Quick actions / view containers / tree & React views / webviews /
 *     subagents / Bots — `lib/plugin/registries/*`
 *   - Slash commands   — `lib/slash-commands/registry.ts`
 *   - Tool-result renderers — `lib/plugin/api/tool-result-renderers.ts`
 *   - Context panels   — `lib/context-workbench/panel-registry.ts`
 *   - Theme registry   — `lib/theme/theme-registry.ts`
 *   - MCP server presets / Skills / Native Anthropic tools —
 *     `lib/plugin/registries/*-registry.ts`
 *   - External agent presets — `lib/ai/agent/external/config/presets.ts`
 *   - External agent adapters — `lib/ai/agent/external/protocol-adapter.ts`
 *   - Connector adapters — `lib/plugin/connectors-bridge.ts`
 *   - Workflow nodes + triggers — `lib/workflow/nodes/catalog.ts`
 *
 * The tab used to be read once and never again, so enabling a plugin while
 * its detail was open showed "no contributions" until the pane was reopened.
 * Every registry that publishes a change signal is subscribed, and the
 * plugin's runtime status is too (the registries without a signal are
 * written during activation, which that status tracks).
 *
 * Where the host already has a way to OPEN a contribution, the chip is a
 * button: commands and quick actions open the command palette on their name,
 * a view container (or a view/webview inside one) switches the shell to it,
 * and a Bot links to the Bots page. The rest stay informational.
 *
 * Categories with zero contributions are hidden so the panel collapses to
 * only what is relevant for this specific plugin. When no category is
 * non-empty the tab shows a single empty-state card.
 */

import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PluginDetailGroup, PluginDetailNone } from "./plugin-detail-group"
import { getPluginManager } from "@/lib/plugin/core/manager"
import {
  listPluginThemes,
  subscribeThemeRegistry,
  type PluginTheme,
} from "@/lib/theme/theme-registry"
import { listMcpServerPresetEntries } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listSkillEntries } from "@/lib/plugin/registries/skill-registry"
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { listDynamicPresetEntries } from "@/lib/ai/agent/external/config/presets"
import { listPluginProtocolAdapters } from "@/lib/ai/agent/external/protocol-adapter"
import { getPluginConnectorKinds } from "@/lib/plugin/bridge/connectors-bridge"
import {
  getPluginCatalogSnapshot,
  subscribePluginCatalog,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import {
  listCommandsByPlugin as listRegisteredCommandsByPlugin,
  subscribeCommandRegistry,
} from "@/lib/plugin/commands/registry"
import {
  getQuickActionSnapshot,
  subscribeQuickActions,
} from "@/lib/plugin/registries/quick-action-registry"
import {
  getViewContainerSnapshot,
  subscribeViewContainers,
} from "@/lib/plugin/registries/view-container-registry"
import { getViewSnapshot, subscribeViews } from "@/lib/plugin/registries/tree-view-registry"
import { getWebviewSnapshot, subscribeWebviews } from "@/lib/plugin/registries/webview-registry"
import { listSubagentEntries } from "@/lib/plugin/registries/subagent-registry"
import { listBotEntries } from "@/lib/plugin/registries/bot-registry"
import {
  listCommandsByPlugin as listSlashCommandsByPlugin,
  subscribeSlashCommands,
} from "@/lib/slash-commands/registry"
import {
  listToolResultRenderers,
  subscribeToolResultRenderers,
} from "@/lib/plugin/api/tool-result-renderers"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { useUIStore } from "@/stores/ui"

interface Props {
  pluginId: string
}

type ContributionLabelKey =
  | "tools"
  | "modes"
  | "commands"
  | "quickActions"
  | "slashCommands"
  | "viewContainers"
  | "views"
  | "webviews"
  | "contextPanels"
  | "toolRenderers"
  | "subagents"
  | "bots"
  | "a2uiComponents"
  | "a2uiTemplates"
  | "themes"
  | "mcpServerPresets"
  | "skills"
  | "nativeAnthropicTools"
  | "externalAgentPresets"
  | "externalAgentAdapters"
  | "connectors"
  | "workflowNodes"
  | "workflowTriggers"
  | "hooks"

/** What "open" means for an actionable contribution. */
type ContributionAction =
  | { kind: "palette"; query: string }
  | { kind: "viewContainer"; containerId: string }
  | { kind: "route"; href: string }

interface ContributionItem {
  /** Unique within its section. */
  key: string
  /** What the chip shows. */
  label: string
  /** The raw id, when it differs from the label (shown as the chip's title). */
  id?: string
  action?: ContributionAction
}

interface Section {
  key: ContributionLabelKey
  items: ContributionItem[]
}

const idItem = (id: string): ContributionItem => ({ key: id, label: id })

/**
 * Theme registry exposes a notify-based subscription. We mirror it through
 * `useSyncExternalStore` so theme registrations flow into the tab without a
 * page reload.
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

/**
 * Re-render on any registry change signal. The registries below publish
 * change events but not a stable snapshot we could hand to
 * `useSyncExternalStore`, so a counter bumped by each signal drives the
 * re-read instead.
 */
function useRegistryRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = () => setRevision((n) => n + 1)
    const unsubscribers = [
      subscribeCommandRegistry(bump),
      subscribeQuickActions(bump),
      subscribeViewContainers(bump),
      subscribeViews(bump),
      subscribeWebviews(bump),
      subscribeSlashCommands(bump),
      subscribeToolResultRenderers(bump),
      contextPanelRegistry.subscribe(bump),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])
  return revision
}

export function PluginContributedTab({ pluginId }: Props) {
  const t = useTranslations("plugins.detail.contributed")
  // Root translator: plugin `titleKey` / `labelKey` values are absolute keys
  // under `plugin.<id>.…`, merged into the bundle by the locale gate.
  const rootT = useTranslations()
  const router = useRouter()
  useRegistryRevision()
  // Registries without a change signal (tools, modes, subagents, Bots, …) are
  // written during activation; the runtime status is what moves when they do.
  usePluginStore((state) => state.plugins[pluginId]?.status)

  const manager = getPluginManager()
  const registry = manager.getRegistry()

  const themes = useThemes(pluginId)
  const catalog = usePluginCatalogEntries(pluginId)

  // Workflow catalog entries split by category so triggers and nodes get
  // their own cards.
  const triggerEntries = catalog.filter((e) => e.category === "trigger")
  const nodeEntries = catalog.filter((e) => e.category !== "trigger")

  const label = (key: string | undefined, fallback: string) =>
    resolvePluginLabel(rootT as never, pluginId, key, fallback)

  // View containers the shell can switch to. `panel` containers have no rail
  // button and are opened by the plugin itself, so they are not a target.
  const containers = getViewContainerSnapshot().filter((c) => c.pluginId === pluginId)
  const openableContainers = new Set(
    getViewContainerSnapshot()
      .filter((c) => c.def.location !== "panel")
      .map((c) => c.fullId)
  )
  const containerAction = (containerId: string | undefined): ContributionAction | undefined =>
    containerId && openableContainers.has(containerId)
      ? { kind: "viewContainer", containerId }
      : undefined

  const quickActions = getQuickActionSnapshot().filter((a) => a.pluginId === pluginId)
  // A quick action mirrors itself into the command registry as its dispatch
  // handle; listing that mirror under Commands too would count it twice.
  const quickActionCommandIds = new Set(quickActions.map((a) => a.commandId))

  const managerCommands = registry.getCommandsByPlugin(pluginId)
  const managerCommandIds = new Set(managerCommands.map((cmd) => cmd.id))
  const commandItems: ContributionItem[] = [
    ...managerCommands.map((cmd) => ({
      key: cmd.id,
      label: cmd.name || cmd.id,
      id: cmd.name && cmd.name !== cmd.id ? cmd.id : undefined,
      action: { kind: "palette", query: cmd.name || cmd.id } as const,
    })),
    ...listRegisteredCommandsByPlugin(pluginId)
      .filter((cmd) => !managerCommandIds.has(cmd.id) && !quickActionCommandIds.has(cmd.id))
      .map((cmd) => ({
        key: cmd.id,
        label: cmd.title || cmd.id,
        id: cmd.title && cmd.title !== cmd.id ? cmd.id : undefined,
        action: { kind: "palette", query: cmd.title || cmd.id } as const,
      })),
  ]

  // Build the section list — order matters for the rendered grid.
  const sections: Section[] = [
    {
      key: "tools",
      items: registry
        .getToolsByPlugin(pluginId)
        .map((tool) =>
          idItem(tool.name === "eval_project_v2" ? t("toolLabels.eval_project_v2") : tool.name)
        ),
    },
    {
      key: "modes",
      items: registry.getModesByPlugin(pluginId).map((mode) => idItem(mode.name ?? mode.id)),
    },
    { key: "commands", items: commandItems },
    {
      key: "quickActions",
      items: quickActions.map((action) => {
        const title = label(action.labelKey, action.title)
        return {
          key: action.fullId,
          label: title,
          id: action.fullId,
          action: { kind: "palette", query: title },
        }
      }),
    },
    {
      key: "slashCommands",
      items: listSlashCommandsByPlugin(pluginId).map((cmd) => ({
        key: cmd.id,
        label: `/${cmd.name}`,
        id: cmd.id,
      })),
    },
    {
      key: "viewContainers",
      items: containers.map((container) => ({
        key: container.fullId,
        label: label(container.def.titleKey, container.def.title),
        id: container.fullId,
        action: containerAction(container.fullId),
      })),
    },
    {
      key: "views",
      items: getViewSnapshot()
        .filter((view) => view.pluginId === pluginId)
        .map((view) => ({
          key: `${view.containerId}/${view.viewId}`,
          label: label(view.titleKey, view.title ?? view.viewId),
          id: view.viewId,
          action: containerAction(view.containerId),
        })),
    },
    {
      key: "webviews",
      items: getWebviewSnapshot()
        .filter((webview) => webview.pluginId === pluginId)
        .map((webview) => ({
          key: `${webview.containerId ?? ""}/${webview.viewId}`,
          label: label(webview.titleKey, webview.title ?? webview.viewId),
          id: webview.viewId,
          action: webview.surface === "panel" ? containerAction(webview.containerId) : undefined,
        })),
    },
    {
      key: "contextPanels",
      items: contextPanelRegistry
        .listPanels()
        .filter((panel) => panel.pluginId === pluginId)
        .map((panel) => ({ key: panel.id, label: panel.label || panel.id, id: panel.id })),
    },
    {
      key: "toolRenderers",
      items: listToolResultRenderers()
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => idItem(entry.toolName)),
    },
    {
      key: "subagents",
      items: listSubagentEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => ({
          key: e.id,
          label: e.entry.name || e.id,
          id: e.entry.name && e.entry.name !== e.id ? e.id : undefined,
        })),
    },
    {
      key: "bots",
      items: listBotEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => ({
          key: e.id,
          label: e.entry.definition.name || e.id,
          id: e.id,
          action: { kind: "route", href: "/bots" } as const,
        })),
    },
    {
      key: "a2uiComponents",
      items: registry.getComponentsByPlugin(pluginId).map((cmp) => idItem(cmp.type)),
    },
    {
      key: "a2uiTemplates",
      items: registry.getTemplatesByPlugin(pluginId).map((tpl) => idItem(tpl.id)),
    },
    {
      key: "themes",
      items: themes.map((th) => ({ key: th.id, label: th.name || th.id })),
    },
    {
      key: "mcpServerPresets",
      items: listMcpServerPresetEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => idItem(e.id)),
    },
    {
      key: "skills",
      items: listSkillEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => idItem(e.id)),
    },
    {
      key: "nativeAnthropicTools",
      items: listNativeAnthropicToolEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => idItem(e.id)),
    },
    {
      key: "externalAgentPresets",
      items: listDynamicPresetEntries()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => idItem(e.id)),
    },
    {
      key: "externalAgentAdapters",
      // listPluginProtocolAdapters() returns { protocol, pluginId } where
      // protocol is the namespaced `${pluginId}:${id}` — render that canonical id.
      items: listPluginProtocolAdapters()
        .filter((e) => e.pluginId === pluginId)
        .map((e) => idItem(e.protocol)),
    },
    {
      key: "connectors",
      items: [...getPluginConnectorKinds(pluginId)].map(idItem),
    },
    {
      key: "workflowNodes",
      items: nodeEntries.map((e) => ({ key: e.kind, label: e.label || e.kind })),
    },
    {
      key: "workflowTriggers",
      items: triggerEntries.map((e) => ({ key: e.kind, label: e.label || e.kind })),
    },
    {
      // Lifecycle hooks the plugin registered (onLoad / onEnable / message
      // pipeline / …). Closes the gap where "hooks" was a filterable
      // capability but the contributed hooks were never listed.
      key: "hooks",
      items: getPluginLifecycleHooks().getHooksByPlugin(pluginId).map(idItem),
    },
  ]

  const populated = sections.filter((s) => s.items.length > 0)

  const run = (action: ContributionAction) => {
    switch (action.kind) {
      case "palette":
        requestCommandPalette({ query: action.query })
        return
      case "viewContainer":
        useUIStore.getState().setSelectedGuild({
          kind: "plugin-view",
          containerId: action.containerId,
        })
        router.push("/")
        return
      case "route":
        router.push(action.href)
        return
    }
  }

  if (populated.length === 0) {
    return <PluginDetailNone message={t("empty")} testId="plugin-contributed-empty" />
  }

  return (
    <div className="space-y-2" data-testid="plugin-contributed-tab">
      {populated.map((section) => (
        <ContributionGroup
          key={section.key}
          labelKey={section.key}
          items={section.items}
          onRun={run}
        />
      ))}
    </div>
  )
}

interface ContributionGroupProps {
  labelKey: ContributionLabelKey
  items: ContributionItem[]
  onRun: (action: ContributionAction) => void
}

// Flat, not a card. These groups already sit inside a collapsible section
// inside the detail pane, so a bordered box here was the third nested frame
// around a row of chips.
function ContributionGroup({ labelKey, items, onRun }: ContributionGroupProps) {
  const t = useTranslations("plugins.detail.contributed")
  return (
    <PluginDetailGroup
      title={t(labelKey)}
      actions={
        <Badge variant="outline" className="text-xs">
          {t("countBadge", { count: items.length })}
        </Badge>
      }
      testId={`contributed-${labelKey}`}
    >
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {items.map((item) =>
          item.action ? (
            <button
              key={item.key}
              type="button"
              onClick={() => onRun(item.action!)}
              title={item.id}
              aria-label={t(`actionAria.${item.action.kind}`, { name: item.label })}
              className="touch-hit inline-flex max-w-full min-w-0 items-center gap-1 rounded-pill bg-secondary px-2 py-0.5 font-mono text-xs text-secondary-foreground outline-none hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{item.label}</span>
              <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
            </button>
          ) : (
            <Badge
              key={item.key}
              variant="secondary"
              className="max-w-full min-w-0 font-mono text-xs"
              title={item.id}
            >
              <span className="truncate">{item.label}</span>
            </Badge>
          )
        )}
      </div>
    </PluginDetailGroup>
  )
}

"use client"

/**
 * Right rail for the desktop discover page.
 *
 * When no `itemId` is selected: shows a per-category overview (count,
 * helper text). When an item is selected: dispatches per-kind to a
 * focused detail panel with the canonical action (enable/disable,
 * open dedicated page, edit). Phase 4 will replace the plugin panel
 * with the install-flow-aware variant.
 */

import { useState } from "react"
import Link from "next/link"
import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { ExternalLinkIcon, Trash2Icon, XIcon } from "lucide-react"

import { CharacterDetailSheet } from "@/components/mobile/discover/character-detail-sheet"
import { PluginMarketplaceSheet } from "@/components/discover/plugin-marketplace-sheet"
import { SkillMarketplaceSheet } from "@/components/discover/skill-marketplace-sheet"
import { TwinProfileCard } from "@/components/discover/twin-profile-card"
import { DiscoverShareButton } from "@/components/discover/discover-share-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { usePluginMarketplace } from "@/hooks/plugins/use-plugin-marketplace"
import { usePlatform } from "@/hooks/use-platform"
import type {
  DiscoverItem,
  DiscoverExternalAgentPreset,
  DiscoverTeamTemplate,
} from "@/hooks/discover/use-discover-query"
import type { Character, McpServer, Skill, Team } from "@cognia/agent-config-types"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { ConnectorMeta } from "@/lib/connectors/adapter-metadata"
import type { DiscoverCategoryId, DiscoverView } from "@/lib/discover/categories"
import type { OcrProvider } from "@/types/ocr"
import type { TwinDraft, TwinSource } from "@/types/twin"
import type { WorkflowCopilotTemplate } from "@/lib/workflow/copilot-templates"
import type { McpPreset } from "@/lib/claude/mcp-presets"
import type { SlashCommandDefinition } from "@/lib/slash-commands/registry"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { getTemplateWarnings } from "@/lib/plugin/registries/agent-team-template-registry"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { listPlugins } from "@/lib/db/plugins"
import { getDb } from "@/lib/db/schema"
import { setSkillStatus } from "@/lib/db/skills"

export interface DiscoverInspectorProps {
  category: DiscoverView
  itemId: string | null
  items: DiscoverItem[]
  onClose: () => void
  className?: string
}

export function DiscoverInspector({
  category,
  itemId,
  items,
  onClose,
  className,
}: DiscoverInspectorProps) {
  const t = useTranslations("discover")
  const selected = itemId ? items.find((i) => i.id === itemId) : null

  if (!selected) {
    return (
      <section
        aria-label={t("inspector.aria")}
        className={className}
        data-testid="discover-inspector-empty"
      >
        <header className="flex flex-col gap-1 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t(`categories.${category}`)}</h2>
          <p className="text-xs text-muted-foreground">
            {t("inspector.itemCount", { count: items.length })}
          </p>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
          <span>{t("inspector.empty")}</span>
          {category === "plugins" ? <PluginMarketplaceCta /> : null}
          {category === "skills" ? <SkillMarketplaceSheet /> : null}
        </div>
      </section>
    )
  }

  return (
    <section
      aria-label={t("inspector.aria")}
      className={className}
      data-testid={`discover-inspector-${selected.kind}-${selected.id}`}
    >
      <InspectorHeader item={selected} onClose={onClose} />
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        <InspectorBody item={selected} />
        <DiscoverShareButton item={selected} />
      </div>
    </section>
  )
}

function InspectorHeader({ item, onClose }: { item: DiscoverItem; onClose: () => void }) {
  const t = useTranslations("discover")
  const locale = useLocale()
  const name = displayName(item, t, locale)
  return (
    <header className="flex items-start gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold" data-testid="discover-inspector-title">
          {name}
        </h2>
        <p className="text-xs text-muted-foreground">{t(`categories.${categoryOf(item)}`)}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        aria-label={t("inspector.close")}
        data-testid="discover-inspector-close"
      >
        <XIcon className="size-4" />
      </Button>
    </header>
  )
}

function InspectorBody({ item }: { item: DiscoverItem }) {
  switch (item.kind) {
    case "character":
      return <CharacterInspector character={item.data} />
    case "team":
      return <TeamInspector team={item.data} />
    case "skill":
      return <SkillInspector skill={item.data} />
    case "plugin":
      return <PluginInspector plugin={item.data} />
    case "mcpServer":
      return <McpServerInspector server={item.data} />
    case "connector":
      return <ConnectorInspector connector={item.data} />
    case "ocrProvider":
      return <OcrProviderInspector provider={item.data} />
    case "workflowTemplate":
      return <WorkflowTemplateInspector template={item.data} />
    case "twinSource":
      return <TwinSourceInspector source={item.data} />
    case "twinDraft":
      return <TwinDraftInspector draft={item.data} />
    case "slashCommand":
      return <SlashCommandInspector command={item.data} />
    case "mcpPreset":
      return <McpPresetInspector preset={item.data} />
    case "teamTemplate":
      return <TeamTemplateInspector template={item.data} />
    case "externalAgentPreset":
      return <ExternalAgentPresetInspector preset={item.data} />
    case "subagent":
      return <SubagentInspector subagent={item.data} itemId={item.id} />
    default: {
      // Exhaustiveness — newer kinds must add a branch above.
      const exhaustive: never = item
      return <pre className="text-xs">{JSON.stringify(exhaustive)}</pre>
    }
  }
}

function CharacterInspector({ character }: { character: Character }) {
  const t = useTranslations("discover")
  const [editOpen, setEditOpen] = useState(false)
  return (
    <>
      {character.description ? (
        <p className="text-sm text-muted-foreground">{character.description}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {character.isBuiltIn ? <Badge variant="outline">{t("builtInBadge")}</Badge> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="default"
          onClick={() => setEditOpen(true)}
          data-testid="discover-inspector-edit-character"
        >
          {t("inspector.openFull")}
        </Button>
      </div>
      <CharacterDetailSheet open={editOpen} character={character} onOpenChange={setEditOpen} />
    </>
  )
}

function TeamInspector({ team }: { team: Team }) {
  const t = useTranslations("discover")
  const memberCount = team.members?.length ?? 0
  return (
    <>
      {team.description ? (
        <p className="text-sm text-muted-foreground">{team.description}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("memberCount", { count: memberCount })}</p>
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-team"
      >
        <Link href={`/agent-teams/workspace?teamId=${encodeURIComponent(team.id)}`}>
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function SkillInspector({ skill }: { skill: Skill }) {
  const t = useTranslations("discover")
  const enabled = skill.status !== "disabled"
  const onToggle = (next: boolean) => {
    const nextStatus = next ? "enabled" : "disabled"
    void setSkillStatus(skill.id, nextStatus)
    void enqueue({
      command: "skill_set_enabled",
      payload: { id: skill.id, enabled: next },
      label: `${next ? "Enable" : "Disable"} skill ${skill.name}`,
    })
  }
  return (
    <>
      {skill.description ? (
        <p className="text-sm text-muted-foreground">{skill.description}</p>
      ) : null}
      <label className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
        <span className="text-sm">{t(enabled ? "inspector.enable" : "inspector.disable")}</span>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={t(enabled ? "inspector.disable" : "inspector.enable")}
          data-testid="discover-inspector-skill-toggle"
        />
      </label>
    </>
  )
}

function PluginInspector({ plugin }: { plugin: PluginRow }) {
  const t = useTranslations("discover")
  const platform = usePlatform()
  const isMobile = platform === "mobile"
  const market = usePluginMarketplace()
  const onToggle = async (next: boolean) => {
    try {
      await getDb().plugins.update(plugin.id, { enabled: next, updatedAt: Date.now() })
      await enqueue({
        command: "plugin_set_enabled",
        payload: { id: plugin.id, enabled: next },
        label: `${next ? "Enable" : "Disable"} plugin ${plugin.name || plugin.id}`,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  const onUninstall = async () => {
    try {
      await market.uninstall(plugin.id)
      toast.success(t("marketplace.uninstallSuccess", { name: plugin.name || plugin.id }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  // Built-in plugins ship inside the desktop binary — uninstall would brick
  // the runtime, so we surface enable/disable only for them.
  const allowUninstall = plugin.source !== "builtin" && !isMobile
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {plugin.version ? <Badge variant="outline">v{plugin.version}</Badge> : null}
        {plugin.source ? <Badge variant="secondary">{plugin.source}</Badge> : null}
      </div>
      <label className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
        <span className="text-sm">
          {t(plugin.enabled ? "inspector.enable" : "inspector.disable")}
        </span>
        <Switch
          checked={plugin.enabled}
          onCheckedChange={(v) => void onToggle(v)}
          aria-label={t(plugin.enabled ? "inspector.disable" : "inspector.enable")}
          data-testid="discover-inspector-plugin-toggle"
        />
      </label>
      {allowUninstall ? (
        <Button
          type="button"
          variant="destructive"
          className="self-start gap-2"
          disabled={market.installingId === plugin.id}
          onClick={() => void onUninstall()}
          data-testid="discover-inspector-plugin-uninstall"
        >
          <Trash2Icon className="size-4" />
          {t("marketplace.uninstall")}
        </Button>
      ) : null}
    </>
  )
}

/**
 * "Browse marketplace" CTA rendered in the empty-state inspector when the
 * user lands on the plugins category without selecting a row. Reads the
 * installed plugin set so the sheet can hide already-installed entries.
 */
function PluginMarketplaceCta() {
  const installedRows = useLiveQuery<readonly PluginRow[]>(() => listPlugins(), []) ?? []
  const installedIds = new Set(installedRows.map((r) => r.id))
  return <PluginMarketplaceSheet installedIds={installedIds} />
}

function TwinSourceInspector({ source }: { source: TwinSource }) {
  const t = useTranslations("discover")
  return (
    <>
      <TwinProfileCard twinId={source.twinId} />
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{source.kind}</Badge>
        <Badge variant="secondary">{source.status}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("inspector.twinSourceMeta", {
          bytes: source.bytes.toLocaleString(),
          chunks: source.chunkCount,
        })}
      </p>
      {source.errorMessage ? (
        <p className="text-xs text-destructive">{source.errorMessage}</p>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-twin-source"
      >
        <Link href="/twin">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function TwinDraftInspector({ draft }: { draft: TwinDraft }) {
  const t = useTranslations("discover")
  const dataName =
    typeof draft.payload?.data?.name === "string" ? (draft.payload.data.name as string) : null
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{draft.kind}</Badge>
        <Badge variant="secondary">{draft.status}</Badge>
      </div>
      {dataName ? <p className="text-sm">{dataName}</p> : null}
      {draft.provenance?.rationale ? (
        <p className="text-sm text-muted-foreground">{draft.provenance.rationale}</p>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-twin"
      >
        <Link href="/twin">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function displayName(
  item: DiscoverItem,
  t: (k: string, params?: Record<string, string | number | Date>) => string,
  locale: string
): string {
  switch (item.kind) {
    case "character":
      return item.data.name
    case "team":
      return item.data.name
    case "skill":
      return item.data.name
    case "plugin":
      return item.data.name || item.data.id
    case "mcpServer":
      return item.data.name
    case "connector":
      return t(`connectorLabels.${item.data.type}`)
    case "ocrProvider":
      return item.data.label
    case "workflowTemplate": {
      const key: "en" | "zh-CN" = locale === "zh-CN" ? "zh-CN" : "en"
      return item.data.label[key] ?? item.data.label.en
    }
    case "twinSource":
      return item.data.title
    case "twinDraft": {
      const dataName =
        typeof item.data.payload?.data?.name === "string"
          ? (item.data.payload.data.name as string)
          : undefined
      return dataName ?? t("inspector.twinDraftFallbackName", { kind: item.data.kind })
    }
    case "slashCommand":
      return `/${item.data.name}`
    case "mcpPreset":
      return item.data.name
    case "teamTemplate":
      return item.data.name
    case "externalAgentPreset":
      return item.data.name
    case "subagent":
      return item.data.name
    default: {
      const exhaustive: never = item
      return (exhaustive as { id?: string }).id ?? ""
    }
  }
}

function categoryOf(item: DiscoverItem): DiscoverCategoryId {
  switch (item.kind) {
    case "character":
      return "characters"
    case "team":
      return "teams"
    case "skill":
      return "skills"
    case "plugin":
      return "plugins"
    case "mcpServer":
      return "mcpTools"
    case "connector":
      return "connectors"
    case "ocrProvider":
      return "ocrProviders"
    case "workflowTemplate":
      return "workflowTemplates"
    case "twinSource":
      return "twinIngest"
    case "twinDraft":
      return "twinDrafts"
    case "slashCommand":
      return "slashCommands"
    case "mcpPreset":
      return "mcpPresets"
    case "teamTemplate":
      return "teamTemplates"
    case "externalAgentPreset":
      return "agentPresets"
    case "subagent":
      return "agentPresets"
    default: {
      const exhaustive: never = item
      return exhaustive
    }
  }
}

function McpServerInspector({ server }: { server: McpServer }) {
  const t = useTranslations("discover")
  const onToggle = async (next: boolean) => {
    try {
      await getDb().mcpServers.update(server.id, { enabled: next, updatedAt: Date.now() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{server.transport}</Badge>
        {server.pluginId ? <Badge variant="secondary">{t("badgePlugin")}</Badge> : null}
      </div>
      <label className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
        <span className="text-sm">
          {t(server.enabled ? "inspector.enable" : "inspector.disable")}
        </span>
        <Switch
          checked={server.enabled}
          onCheckedChange={(v) => void onToggle(v)}
          aria-label={t(server.enabled ? "inspector.disable" : "inspector.enable")}
          data-testid="discover-inspector-mcp-toggle"
        />
      </label>
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-mcp"
      >
        <Link href="/settings/external-bridge">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function ConnectorInspector({ connector }: { connector: ConnectorMeta }) {
  const t = useTranslations("discover")
  const planned = connector.status === "planned"
  const githubDelivery = connector.type === "github"
  const settingsHref = githubDelivery
    ? "/settings/github-delivery"
    : `/settings/connections?platform=${connector.type}`
  // Live count of configured adapter instances for this platform — drives
  // the "N configured" badge so the user sees current state without
  // navigating to /settings/connections. Skip the read entirely for
  // `planned` platforms (no adapter row will ever exist) and GitHub Delivery
  // (plugin-owned delivery surface, not a native adapter-registry instance).
  const instances = useLiveQuery<readonly AdapterInstanceRow[]>(
    () =>
      planned || githubDelivery
        ? Promise.resolve<readonly AdapterInstanceRow[]>([])
        : listAdapterInstancesByType(connector.type),
    [connector.type, planned, githubDelivery]
  )
  const instanceCount = instances?.length ?? 0
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(`connectorDescriptions.${connector.type}`)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Badge variant={connector.status === "stable" ? "outline" : "secondary"}>
          {t(`connectorStatus.${connector.status}`)}
        </Badge>
        {/* i18n-exempt: OAuth is a protocol proper noun */}
        {connector.oauth ? <Badge variant="outline">OAuth</Badge> : null}
        {/* i18n-exempt: A2UI is a protocol proper noun */}
        {connector.richMessages ? <Badge variant="outline">A2UI</Badge> : null}
      </div>
      {!planned && !githubDelivery ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="discover-inspector-connector-count"
        >
          {t("connectorInstanceCount", { count: instanceCount })}
        </p>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        disabled={planned}
        aria-disabled={planned}
        data-testid="discover-inspector-open-connector"
      >
        <Link
          href={planned ? "#" : settingsHref}
          onClick={planned ? (e) => e.preventDefault() : undefined}
        >
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function OcrProviderInspector({ provider }: { provider: OcrProvider }) {
  const t = useTranslations("discover")
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{t(`ocrCategories.${provider.category}`)}</Badge>
        {provider.shells.tauri ? <Badge variant="secondary">{t("shellDesktop")}</Badge> : null}
        {provider.shells.capacitor ? <Badge variant="secondary">{t("shellMobile")}</Badge> : null}
        {provider.shells.browser ? <Badge variant="secondary">{t("shellWeb")}</Badge> : null}
      </div>
      {provider.credentialKeys.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("ocrBadge.needsCredentials")}: {provider.credentialKeys.join(", ")}
        </p>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-ocr"
      >
        <Link href="/settings/ocr">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function WorkflowTemplateInspector({ template }: { template: WorkflowCopilotTemplate }) {
  const t = useTranslations("discover")
  const locale = useLocale()
  const key: "en" | "zh-CN" = locale === "zh-CN" ? "zh-CN" : "en"
  const description = template.description[key] ?? template.description.en
  return (
    <>
      <p className="text-sm text-muted-foreground">{description}</p>
      {template.tags && template.tags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {template.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-template"
      >
        <Link href={`/workflows?template=${encodeURIComponent(template.id)}`}>
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

function SlashCommandInspector({ command }: { command: SlashCommandDefinition }) {
  const t = useTranslations("discover")
  return (
    <>
      {command.description ? (
        <p className="text-sm text-muted-foreground">{command.description}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{command.source ?? "chat"}</Badge>
        {command.category ? <Badge variant="secondary">{command.category}</Badge> : null}
        {command.shortcut ? <Badge variant="outline">{command.shortcut}</Badge> : null}
      </div>
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
        /{command.name}
      </p>
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-slash-command"
      >
        <Link href="/settings/slash-commands">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.manageCommands")}
        </Link>
      </Button>
    </>
  )
}

function McpPresetInspector({ preset }: { preset: McpPreset }) {
  const t = useTranslations("discover")
  return (
    <>
      <p className="text-sm text-muted-foreground">{preset.description}</p>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{preset.transport}</Badge>
        {(preset.tags ?? []).map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </div>
      {preset.fields.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("inspector.mcpPresetFields", { count: preset.fields.length })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          asChild
          variant="default"
          className="self-start"
          data-testid="discover-inspector-add-mcp-preset"
        >
          <Link href={`/settings/external-bridge?preset=${encodeURIComponent(preset.id)}`}>
            <ExternalLinkIcon className="size-4" />
            {t("inspector.addMcpServer")}
          </Link>
        </Button>
        {preset.docsUrl ? (
          <Button asChild variant="outline" className="self-start">
            <a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">
              {t("inspector.viewDocs")}
            </a>
          </Button>
        ) : null}
      </div>
    </>
  )
}

function TeamTemplateInspector({ template }: { template: DiscoverTeamTemplate }) {
  const t = useTranslations("discover")
  // Plugin-contributed templates may declare cross-capability dependencies; a
  // missing one surfaces as a non-blocking warning chip.
  const warnings = template.pluginId ? getTemplateWarnings(template.id) : []
  return (
    <>
      <p className="text-sm text-muted-foreground">{template.description}</p>
      <div className="flex flex-wrap gap-2">
        {template.isBuiltIn ? <Badge variant="outline">{t("builtInBadge")}</Badge> : null}
        {template.category ? <Badge variant="secondary">{template.category}</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("memberCount", { count: template.teammateCount })}
      </p>
      {warnings.length > 0 ? (
        <p className="text-xs text-destructive" data-testid="discover-inspector-template-warnings">
          {t("inspector.templateMissingDeps", { count: warnings.length })}
        </p>
      ) : null}
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-use-template"
      >
        <Link href="/agent-teams">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.useTemplate")}
        </Link>
      </Button>
    </>
  )
}

function ExternalAgentPresetInspector({ preset }: { preset: DiscoverExternalAgentPreset }) {
  const t = useTranslations("discover")
  return (
    <>
      <p className="text-sm text-muted-foreground">{preset.description}</p>
      {preset.tags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {preset.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      {preset.setupHint ? (
        <p className="text-xs text-muted-foreground">{preset.setupHint}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          asChild
          variant="default"
          className="self-start"
          data-testid="discover-inspector-add-external-agent"
        >
          <Link href="/me/external-agents">
            <ExternalLinkIcon className="size-4" />
            {t("inspector.addExternalAgent")}
          </Link>
        </Button>
        {preset.docsUrl ? (
          <Button asChild variant="outline" className="self-start">
            <a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">
              {t("inspector.viewDocs")}
            </a>
          </Button>
        ) : null}
      </div>
    </>
  )
}

function SubagentInspector({ subagent, itemId }: { subagent: PluginSubagentDef; itemId: string }) {
  const t = useTranslations("discover")
  const builtIn = !itemId.includes(":")
  return (
    <>
      <p className="text-sm text-muted-foreground">{subagent.description}</p>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{builtIn ? t("builtInBadge") : "plugin"}</Badge>
        {subagent.model ? <Badge variant="secondary">{subagent.model}</Badge> : null}
      </div>
      <Button
        asChild
        variant="default"
        className="self-start"
        data-testid="discover-inspector-open-subagent"
      >
        <Link href="/me/subagents">
          <ExternalLinkIcon className="size-4" />
          {t("inspector.openFull")}
        </Link>
      </Button>
    </>
  )
}

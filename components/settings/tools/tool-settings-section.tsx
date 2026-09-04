"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  BoxIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CpuIcon,
  FileSearchIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { isTauri } from "@/lib/tauri"
import {
  BUILTIN_TOOL_CATEGORIES,
  type BuiltinToolCategory,
  type BuiltinToolCategoryId,
  type BuiltinToolRiskLevel,
  namespaced,
} from "@/lib/settings/builtin-tools"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import { AlwaysAllowList } from "./always-allow-list"
import { ToolCatalogBrowser } from "./tool-catalog-browser"

const CATEGORY_ICONS: Record<BuiltinToolCategoryId, React.ReactNode> = {
  fileExtras: <FolderOpenIcon className="h-4 w-4" />,
  coreFiles: <FileSearchIcon className="h-4 w-4" />,
  git: <GitBranchIcon className="h-4 w-4" />,
  process: <CpuIcon className="h-4 w-4" />,
  environment: <BoxIcon className="h-4 w-4" />,
  shellAdvanced: <TerminalIcon className="h-4 w-4" />,
  terminalRepl: <TerminalIcon className="h-4 w-4" />,
  lsp: <CodeIcon className="h-4 w-4" />,
  codeGraph: <CodeIcon className="h-4 w-4" />,
  astGrep: <FileSearchIcon className="h-4 w-4" />,
  dependencyResearch: <BoxIcon className="h-4 w-4" />,
  webclone: <GlobeIcon className="h-4 w-4" />,
}

function riskLabelKey(level: BuiltinToolRiskLevel): string {
  switch (level) {
    case "low":
      return "riskLow"
    case "medium":
      return "riskMedium"
    case "high":
      return "riskHigh"
  }
}

function riskBadgeClass(level: BuiltinToolRiskLevel): string {
  switch (level) {
    case "low":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "medium":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "high":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
  }
}

/**
 * Settings page for the sidecar's built-in `cognia-tools` MCP server.
 * Lets the user toggle each category, see which tools sit inside it, and
 * manage the always-allow list at the bottom.
 */
export function ToolSettingsSection() {
  const t = useTranslations("toolSettings")
  const settings = useSettingsStore((s) => s.settings)
  const setBuiltinToolEnabled = useSettingsStore((s) => s.setBuiltinToolEnabled)

  const setWebToolsEnabled = useSettingsStore((s) => s.setWebToolsEnabled)
  const setWebToolsPreferCognia = useSettingsStore((s) => s.setWebToolsPreferCognia)
  const setWebToolsAllowPrivateHosts = useSettingsStore((s) => s.setWebToolsAllowPrivateHosts)
  const setWebToolsAlwaysDistill = useSettingsStore((s) => s.setWebToolsAlwaysDistill)
  const setSkillToolEnabled = useSettingsStore((s) => s.setSkillToolEnabled)
  const setSlashCommandToolEnabled = useSettingsStore((s) => s.setSlashCommandToolEnabled)
  const setTeamCollaborationToolEnabled = useSettingsStore((s) => s.setTeamCollaborationToolEnabled)
  const setVectorToolEnabled = useSettingsStore((s) => s.setVectorToolEnabled)
  const setSpawnTaskToolEnabled = useSettingsStore((s) => s.setSpawnTaskToolEnabled)
  const setSessionMessagingToolEnabled = useSettingsStore((s) => s.setSessionMessagingToolEnabled)
  const setTemplateToolsEnabled = useSettingsStore((s) => s.setTemplateToolsEnabled)
  const setPetToolsEnabled = useSettingsStore((s) => s.setPetToolsEnabled)

  const builtinTools = settings?.builtinTools ?? DEFAULT_BUILTIN_TOOLS
  const webToolsEnabled = settings?.webTools?.enabled ?? true
  // The switch used to be "use the SDK's natives on Anthropic", defaulting off.
  // Native is the default resolution now (`lib/chat/web-access.ts`), so the
  // remaining choice is the opposite one: take Cognia's multi-provider search
  // even where a native exists.
  const webPreferCognia = settings?.webTools?.preferCognia ?? false
  const webAllowPrivateHosts = settings?.webTools?.allowPrivateHosts ?? false
  const webAlwaysDistill = settings?.webTools?.alwaysDistill ?? false
  const skillToolEnabled = settings?.selfInvokeTools?.skill ?? false
  const slashCommandToolEnabled = settings?.selfInvokeTools?.slashCommand ?? false
  const teamCollaborationToolEnabled = settings?.selfInvokeTools?.teamCollaboration ?? false
  const vectorToolEnabled = settings?.selfInvokeTools?.vector ?? false
  const spawnTaskToolEnabled = settings?.selfInvokeTools?.spawnTask ?? false
  const sessionMessagingToolEnabled = settings?.selfInvokeTools?.sessionMessaging ?? false
  const templateToolsEnabled = settings?.selfInvokeTools?.templates ?? false
  const petToolsEnabled = settings?.selfInvokeTools?.pet ?? false
  const desktop = isTauri()

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Alert className="py-2">
        <ShieldIcon className="h-3.5 w-3.5" />
        <AlertTitle className="text-sm">{t("permissionsTitle")}</AlertTitle>
        <AlertDescription className="text-xs">{t("permissionsDesc")}</AlertDescription>
      </Alert>

      {!desktop && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangleIcon className="h-3.5 w-3.5" />
          <AlertTitle className="text-sm">{t("desktopRequired")}</AlertTitle>
          <AlertDescription className="text-xs">{t("desktopRequiredDesc")}</AlertDescription>
        </Alert>
      )}

      {/* Web tools are host-routed (renderer + CLI), so unlike the sidecar
          categories they work in the browser too — not desktop-gated. */}
      <Card className={!webToolsEnabled ? "opacity-60" : undefined}>
        <CardHeader className="pb-2 pt-3 px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <GlobeIcon className="h-4 w-4" />
              <CardTitle className="text-sm truncate">{t("webCardTitle")}</CardTitle>
              <Badge variant="outline" className={`text-[9px] uppercase ${riskBadgeClass("low")}`}>
                {t("riskLow")}
              </Badge>
            </div>
            <Switch
              checked={webToolsEnabled}
              onCheckedChange={(next) => setWebToolsEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("webCardTitle") })}
            />
          </div>
          <CardDescription className="text-[11px] leading-snug pt-1">
            {t("webCardDesc")}
          </CardDescription>
          {webToolsEnabled && desktop && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium">{t("webPreferCogniaTitle")}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("webPreferCogniaDesc")}
                </p>
              </div>
              <Switch
                checked={webPreferCognia}
                onCheckedChange={(next) => setWebToolsPreferCognia(next)}
                aria-label={t("toggleAriaLabel", { name: t("webPreferCogniaTitle") })}
              />
            </div>
          )}
          {webToolsEnabled && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium">{t("webAlwaysDistillTitle")}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("webAlwaysDistillDesc")}
                </p>
              </div>
              <Switch
                checked={webAlwaysDistill}
                onCheckedChange={(next) => setWebToolsAlwaysDistill(next)}
                aria-label={t("toggleAriaLabel", { name: t("webAlwaysDistillTitle") })}
              />
            </div>
          )}
          {webToolsEnabled && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed border-amber-500/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium">{t("webAllowPrivateTitle")}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("webAllowPrivateDesc")}
                </p>
              </div>
              <Switch
                checked={webAllowPrivateHosts}
                onCheckedChange={(next) => setWebToolsAllowPrivateHosts(next)}
                aria-label={t("toggleAriaLabel", { name: t("webAllowPrivateTitle") })}
              />
            </div>
          )}
        </CardHeader>
      </Card>

      {/* Agent self-invocation tools (Skill / SlashCommand). Host-routed, so
          they work in the browser too — not desktop-gated. Opt-in (default off). */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <div className="flex items-center gap-2 min-w-0">
            <SparklesIcon className="h-4 w-4" />
            <CardTitle className="text-sm truncate">{t("selfInvokeCardTitle")}</CardTitle>
          </div>
          <CardDescription className="text-[11px] leading-snug pt-1">
            {t("selfInvokeCardDesc")}
          </CardDescription>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("skillToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">{t("skillToolDesc")}</p>
            </div>
            <Switch
              checked={skillToolEnabled}
              onCheckedChange={(next) => setSkillToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("skillToolTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("spawnTaskToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("spawnTaskToolDesc")}
              </p>
            </div>
            <Switch
              checked={spawnTaskToolEnabled}
              onCheckedChange={(next) => setSpawnTaskToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("spawnTaskToolTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("sessionMessagingToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("sessionMessagingToolDesc")}
              </p>
            </div>
            <Switch
              checked={sessionMessagingToolEnabled}
              onCheckedChange={(next) => setSessionMessagingToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("sessionMessagingToolTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("templateToolsTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("templateToolsDesc")}
              </p>
            </div>
            <Switch
              checked={templateToolsEnabled}
              onCheckedChange={(next) => setTemplateToolsEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("templateToolsTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("petToolsTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">{t("petToolsDesc")}</p>
            </div>
            <Switch
              checked={petToolsEnabled}
              onCheckedChange={(next) => setPetToolsEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("petToolsTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("slashToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">{t("slashToolDesc")}</p>
            </div>
            <Switch
              checked={slashCommandToolEnabled}
              onCheckedChange={(next) => setSlashCommandToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("slashToolTitle") })}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("teamCollabToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("teamCollabToolDesc")}
              </p>
            </div>
            <Switch
              checked={teamCollaborationToolEnabled}
              onCheckedChange={(next) => setTeamCollaborationToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("teamCollabToolTitle") })}
            />
          </div>
          {/* Vector memory runs against the native sqlite-vec store, so unlike
              the other self-invoke tools it is desktop-only. */}
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium">{t("vectorToolTitle")}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {desktop ? t("vectorToolDesc") : t("vectorToolDesktopOnly")}
              </p>
            </div>
            <Switch
              checked={vectorToolEnabled}
              disabled={!desktop}
              onCheckedChange={(next) => setVectorToolEnabled(next)}
              aria-label={t("toggleAriaLabel", { name: t("vectorToolTitle") })}
            />
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {BUILTIN_TOOL_CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat.id}
            category={cat}
            enabled={builtinTools[cat.id] ?? false}
            disabled={!desktop}
            onToggle={(next) => setBuiltinToolEnabled(cat.id, next)}
            // `coreFilesOnAnthropic` is a modifier on this category rather than
            // a category of its own, so it has no entry in
            // `BUILTIN_TOOL_CATEGORIES` and had no control here — while the CLI
            // settings panel has always offered it and the CLI↔App bridge
            // pushes it across. It belongs with the switch it modifies.
            subOption={
              cat.id === "coreFiles"
                ? {
                    testid: "builtin-core-files-on-anthropic",
                    checked: builtinTools.coreFilesOnAnthropic === true,
                    onToggle: (next) => setBuiltinToolEnabled("coreFilesOnAnthropic", next),
                  }
                : undefined
            }
          />
        ))}
      </div>

      <ToolCatalogBrowser />

      <AlwaysAllowList />
    </div>
  )
}

interface CategoryCardProps {
  category: BuiltinToolCategory
  enabled: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  /** An extra switch that only makes sense while this category is on. */
  subOption?: {
    testid: string
    checked: boolean
    onToggle: (next: boolean) => void
  }
}

function CategoryCard({ category, enabled, disabled, onToggle, subOption }: CategoryCardProps) {
  const t = useTranslations("toolSettings")
  const [expanded, setExpanded] = useState(false)

  return (
    <Card className={!enabled ? "opacity-60" : undefined}>
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {CATEGORY_ICONS[category.id]}
            <CardTitle className="text-sm truncate">{t(category.nameKey)}</CardTitle>
            {category.requiresApproval && (
              <AlertTriangleIcon
                className="h-3.5 w-3.5 text-amber-500"
                aria-label={t("requiresApprovalIconLabel")}
              />
            )}
            <Badge
              variant="outline"
              className={`text-[9px] uppercase ${riskBadgeClass(category.riskLevel)}`}
            >
              {t(riskLabelKey(category.riskLevel))}
            </Badge>
          </div>
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onToggle}
            aria-label={t("toggleAriaLabel", { name: t(category.nameKey) })}
          />
        </div>
        <CardDescription className="text-[11px] leading-snug pt-1">
          {t(category.descriptionKey)}
        </CardDescription>
      </CardHeader>

      {enabled && (
        <CardContent className="pt-0 pb-3 px-4">
          {subOption && (
            <div
              className="mb-2 flex items-start justify-between gap-2 rounded border px-2 py-1.5"
              data-testid={subOption.testid}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-[11px] leading-snug font-medium">
                  {t("coreFilesOnAnthropic.label")}
                </p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("coreFilesOnAnthropic.description")}
                </p>
              </div>
              <Switch
                checked={subOption.checked}
                disabled={disabled}
                onCheckedChange={subOption.onToggle}
                aria-label={t("coreFilesOnAnthropic.label")}
              />
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDownIcon className="h-3 w-3 mr-1" />
            ) : (
              <ChevronRightIcon className="h-3 w-3 mr-1" />
            )}
            {t(expanded ? "hideTools" : "showTools", { count: category.tools.length })}
          </Button>

          {expanded && (
            <div className="mt-2 flex flex-wrap gap-1">
              {category.tools.map((tool) => (
                <Badge
                  key={tool.name}
                  variant={tool.requiresApproval ? "outline" : "secondary"}
                  className={
                    "text-[10px] font-mono " +
                    (tool.requiresApproval
                      ? "border-amber-500/50 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      : "")
                  }
                  title={`${namespaced(tool.name)} — ${t(tool.descriptionKey)}`}
                >
                  {tool.name}
                  {tool.requiresApproval && <AlertTriangleIcon className="h-2.5 w-2.5 ml-1" />}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

export default ToolSettingsSection

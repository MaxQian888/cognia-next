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
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

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
  const setWebToolsNativeOnAnthropic = useSettingsStore((s) => s.setWebToolsNativeOnAnthropic)

  const builtinTools = settings?.builtinTools ?? DEFAULT_BUILTIN_TOOLS
  const webToolsEnabled = settings?.webTools?.enabled ?? true
  const webNativeOnAnthropic = settings?.webTools?.nativeOnAnthropic ?? false
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
                <p className="text-[12px] font-medium">{t("webNativeAnthropicTitle")}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("webNativeAnthropicDesc")}
                </p>
              </div>
              <Switch
                checked={webNativeOnAnthropic}
                onCheckedChange={(next) => setWebToolsNativeOnAnthropic(next)}
                aria-label={t("toggleAriaLabel", { name: t("webNativeAnthropicTitle") })}
              />
            </div>
          )}
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
}

function CategoryCard({ category, enabled, disabled, onToggle }: CategoryCardProps) {
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

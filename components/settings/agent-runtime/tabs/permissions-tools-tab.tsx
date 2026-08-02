"use client"

// Permissions & Tools panel — Always-allow add input + reused
// `<AlwaysAllowList />` + the built-in tool categories (file extras / git /
// process / environment / shell advanced) as one divided list. Web mode
// disables every category switch since the cognia-tools MCP server only
// runs inside the Tauri sidecar.
//
// Card-free: the categories used to be five `<Card>`s in a grid, each holding
// one title, one badge and one switch — a toggle list wearing five borders.
// They are rows in one bordered list now, and the surrounding groups are
// `SettingsBlock`s inside the runtime pane's own frame.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon, PlusIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

import { AlwaysAllowList } from "@/components/settings/tools/always-allow-list"
import { CommandAutoModeCard } from "@/components/settings/agent-runtime/command-auto-mode-card"
import { ToolPermissionRulesCard } from "@/components/settings/agent-runtime/tool-permission-rules-card"
import { ToolSearchRuntimeCard } from "@/components/settings/agent-runtime/tool-search-runtime-card"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import {
  BUILTIN_TOOL_CATEGORIES,
  listNamespacedToolsInCategory,
  namespaced,
  type BuiltinToolCategoryId,
} from "@/lib/settings/builtin-tools"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

export function PermissionsToolsTab() {
  const t = useTranslations("settings.agentRuntimeSection.permissions")
  const settings = useSettingsStore((s) => s.settings)
  const setBuiltinToolEnabled = useSettingsStore((s) => s.setBuiltinToolEnabled)
  const toggleAlwaysAllow = useSettingsStore((s) => s.toggleAlwaysAllow)
  const desktop = isTauri()

  const [draft, setDraft] = useState("")

  const builtin = settings?.builtinTools ?? DEFAULT_BUILTIN_TOOLS

  const handleAddManual = async () => {
    const name = draft.trim()
    if (!name) return
    // The list dedupes silently inside addAlwaysAllow, but namespacing a
    // bare name (e.g. user typed `file_hash` rather than the full
    // `mcp__cognia-tools__file_hash`) avoids confusing the agent's
    // permission resolver. Heuristic: if the input has no `mcp__` prefix
    // and matches a known built-in tool, namespace it; otherwise pass
    // through verbatim so users can still allow third-party MCP tools.
    const looksNamespaced = name.includes("__")
    const builtinNames = new Set(
      BUILTIN_TOOL_CATEGORIES.flatMap((c) => c.tools.map((tl) => tl.name))
    )
    const finalName = !looksNamespaced && builtinNames.has(name) ? namespaced(name) : name
    await toggleAlwaysAllow(finalName, true)
    setDraft("")
    toast.success(t("addedToast", { tool: finalName }))
  }

  const handleApproveAllBuiltin = async () => {
    const all = (BUILTIN_TOOL_CATEGORIES.map((c) => c.id) as BuiltinToolCategoryId[]).flatMap(
      (id) => listNamespacedToolsInCategory(id)
    )
    for (const name of all) {
      await toggleAlwaysAllow(name, true)
    }
    toast.success(t("approveAllBuiltinDoneToast", { count: all.length }))
  }

  return (
    <SettingsStack>
      <CommandAutoModeCard />

      <ToolPermissionRulesCard />

      <ToolSearchRuntimeCard />

      <SettingsBlock
        icon={<ShieldCheckIcon />}
        title={t("alwaysAllowTitle")}
        description={t("alwaysAllowDesc")}
      >
        <div className="flex flex-col gap-2 @md/settings-stack:flex-row @md/settings-stack:items-center">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("addToolPlaceholder")}
            aria-label={t("addToolPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleAddManual()
              }
            }}
            className="flex-1"
          />
          <div className="flex shrink-0 flex-row gap-2">
            <Button onClick={() => void handleAddManual()} disabled={!draft.trim()}>
              <PlusIcon className="mr-2 size-4" />
              {t("addBtn")}
            </Button>
            <Button variant="outline" onClick={() => void handleApproveAllBuiltin()}>
              {t("approveAllBuiltin")}
            </Button>
          </div>
        </div>

        <AlwaysAllowList />
      </SettingsBlock>

      <SettingsBlock
        title={t("categoriesTitle")}
        description={!desktop ? t("desktopOnlyHint") : undefined}
        contentClassName="space-y-0"
      >
        {/* One divided list, not one card per toggle. */}
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border">
          {BUILTIN_TOOL_CATEGORIES.map((cat) => {
            const checked = builtin[cat.id as BuiltinToolCategoryId] ?? false
            const riskColor =
              cat.riskLevel === "high"
                ? "bg-destructive/15 text-destructive"
                : cat.riskLevel === "medium"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            return (
              <li key={cat.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t(`categories.${cat.id}.name`)}
                    <Badge variant="outline" className={`text-[10px] ${riskColor}`}>
                      {t(`risk.${cat.riskLevel}`)}
                    </Badge>
                  </p>
                  <p className="text-xs text-pretty text-muted-foreground">
                    {t(`categories.${cat.id}.desc`)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("infoLabel", { name: t(`categories.${cat.id}.name`) })}
                      >
                        <InfoIcon className="size-3.5" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 text-xs">
                      <p className="mb-2 font-medium">
                        {t("infoListTitle", { count: cat.tools.length })}
                      </p>
                      <ul className="space-y-1">
                        {cat.tools.map((tl) => (
                          <li key={tl.name} className="font-mono text-[11px]">
                            {namespaced(tl.name)}
                          </li>
                        ))}
                      </ul>
                    </PopoverContent>
                  </Popover>
                  <Switch
                    checked={Boolean(checked)}
                    disabled={!desktop}
                    onCheckedChange={(v) =>
                      void setBuiltinToolEnabled(cat.id as BuiltinToolCategoryId, v)
                    }
                    aria-label={t(`categories.${cat.id}.name`)}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </SettingsBlock>
    </SettingsStack>
  )
}

export default PermissionsToolsTab

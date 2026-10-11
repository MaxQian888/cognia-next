"use client"

// Right-side filter sheet that drives the shared `usePluginsStore.filters`.
// Mirrors `components/skills/skill-filter-sheet.tsx` but exposes plugin-
// specific axes: capability / permission / source / status / tag /
// signed-only / hasUpdate. Sort lives in the library header as a first-class
// control.
//
// Every option is labelled in the user's language with the vocabulary the
// rest of the panel already uses: statuses with the status pill's words,
// sources with the source badge's, permissions with their permission
// description (the id rides along in mono for the people who know it).

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { usePlugins } from "@/hooks/plugins"
import { usePermissionDescription } from "@/hooks/plugins/use-permission-description"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePluginsStore } from "@/stores/plugins"
import { PERMISSION_GROUPS } from "@/lib/plugin/security/permission-guard"
import { CAPABILITY_META } from "../plugin-capabilities"
import { PLUGIN_SOURCES } from "../plugin-source-badge"

/**
 * The statuses a user can ask for, each resolved by `pluginRowMatchesStatus`
 * (hooks/plugins/use-plugins.ts) against the persisted enable flag and the
 * lifecycle error. The sheet used to list the eleven raw runtime statuses,
 * which filtered on a Dexie column the runtime never writes back — "enabled"
 * matched nothing an enable produced.
 */
export const PLUGIN_STATUS_FILTER_OPTIONS = ["enabled", "disabled", "error"] as const

const ANY_TAG = "__any__"

/**
 * Every manifest keyword across the installed plugins, deduplicated without
 * regard to case (the tag filter compares case-insensitively) and sorted for
 * the UI language. Pure, so the option list is pinned by tests.
 */
export function collectPluginKeywords(rows: readonly PluginRow[], locale = "en"): string[] {
  const byLower = new Map<string, string>()
  for (const row of rows) {
    const raw = (row.manifest as { keywords?: unknown })?.keywords
    if (!Array.isArray(raw)) continue
    for (const keyword of raw) {
      if (typeof keyword !== "string") continue
      const trimmed = keyword.trim()
      if (trimmed && !byLower.has(trimmed.toLowerCase()))
        byLower.set(trimmed.toLowerCase(), trimmed)
    }
  }
  return [...byLower.values()].sort((a, b) => a.localeCompare(b, locale))
}

export function PluginFilterSheet() {
  const t = useTranslations("plugins.filterSheet")
  const tc = useTranslations("plugins.categorySidebar")
  const tStatus = useTranslations("plugins.card.status")
  const tSource = useTranslations("plugins.source")
  const describePermission = usePermissionDescription()
  const locale = useLocale()
  const { all } = usePlugins()
  const open = usePluginsStore((s) => s.filterSheetOpen)
  const setOpen = usePluginsStore((s) => s.setFilterSheetOpen)
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const resetFilters = usePluginsStore((s) => s.resetFilters)

  const allPermissions = [...new Set(Object.values(PERMISSION_GROUPS).flat())]
  const keywords = useMemo(() => collectPluginKeywords(all, locale), [all, locale])
  // A tag set from a keyword chip the list no longer carries (or typed into a
  // deep link) must still show as the current value, or the Select would read
  // "Any" while the list stays narrowed.
  const tagOptions =
    filters.tag && !keywords.some((k) => k.toLowerCase() === filters.tag!.toLowerCase())
      ? [filters.tag, ...keywords]
      : keywords
  const selectedTag =
    filters.tag === null
      ? ANY_TAG
      : (tagOptions.find((k) => k.toLowerCase() === filters.tag!.toLowerCase()) ?? filters.tag)
  // Same rule for a status this sheet does not offer (an older deep link).
  const statusOptions: string[] =
    filters.status === "all" ||
    (PLUGIN_STATUS_FILTER_OPTIONS as readonly string[]).includes(filters.status)
      ? [...PLUGIN_STATUS_FILTER_OPTIONS]
      : [...PLUGIN_STATUS_FILTER_OPTIONS, filters.status]
  const statusLabel = (status: string) =>
    (PLUGIN_STATUS_FILTER_OPTIONS as readonly string[]).includes(status)
      ? tStatus(status as never)
      : status

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6" data-testid="plugin-filter-sheet-body">
          <FilterField label={t("query")}>
            <Input
              className="pointer-coarse:h-10"
              value={filters.query}
              onChange={(e) => setFilters({ query: e.target.value })}
              placeholder={t("queryPlaceholder")}
            />
          </FilterField>

          <FilterField label={t("capability")}>
            <Select value={filters.capability} onValueChange={(v) => setFilters({ capability: v })}>
              <SelectTrigger className="w-full pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {CAPABILITY_META.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {tc(`capability.${c.i18nKey}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("permission")}>
            <Select value={filters.permission} onValueChange={(v) => setFilters({ permission: v })}>
              <SelectTrigger className="w-full pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {allPermissions.map((p) => (
                  <SelectItem key={p} value={p}>
                    <span className="truncate">{describePermission(p)}</span>
                    <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {p}
                    </code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("source")}>
            <Select value={filters.source} onValueChange={(v) => setFilters({ source: v })}>
              <SelectTrigger className="w-full pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {PLUGIN_SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {tSource(source as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("status")}>
            <Select value={filters.status} onValueChange={(v) => setFilters({ status: v })}>
              <SelectTrigger className="w-full pointer-coarse:h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("tag")}>
            <Select
              value={selectedTag}
              onValueChange={(v) => setFilters({ tag: v === ANY_TAG ? null : v })}
              disabled={tagOptions.length === 0}
            >
              <SelectTrigger
                className="w-full pointer-coarse:h-10"
                data-testid="plugin-filter-sheet-tag"
              >
                <SelectValue placeholder={t("tagNone")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_TAG}>{t("any")}</SelectItem>
                {tagOptions.map((keyword) => (
                  <SelectItem key={keyword} value={keyword}>
                    {keyword}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tagOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("tagNone")}</p>
            ) : null}
          </FilterField>

          <Separator />

          <ToggleField
            id="filter-signed-only"
            label={t("signedOnly")}
            checked={filters.signedOnly}
            onCheckedChange={(v) => setFilters({ signedOnly: v })}
          />
          <ToggleField
            id="filter-has-update"
            label={t("hasUpdate")}
            checked={filters.hasUpdate}
            onCheckedChange={(v) => setFilters({ hasUpdate: v })}
          />
        </div>

        <SheetFooter className="mt-4">
          <Button variant="outline" onClick={() => resetFilters()}>
            {t("reset")}
          </Button>
          <Button onClick={() => setOpen(false)}>{t("apply")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function ToggleField({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

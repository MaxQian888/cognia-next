"use client"

// Right-side filter sheet that drives the shared `usePluginsStore.filters`.
// Mirrors `components/skills/skill-filter-sheet.tsx` but exposes plugin-
// specific axes: capability / permission / source / status / signed-only /
// hasUpdate / sort.

import { useTranslations } from "next-intl"
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
import { usePluginsStore } from "@/stores/plugins"
import { PERMISSION_GROUPS } from "@/lib/plugin/security/permission-guard"

const CAPABILITY_OPTIONS = [
  "tools",
  "components",
  "modes",
  "skills",
  "media",
  "canvas",
  "ai-provider",
  "themes",
  "commands",
  "hooks",
  "processors",
  "providers",
  "exporters",
  "importers",
  "a2ui",
  "python",
  "scheduler",
  "external-agent-preset",
] as const

const STATUS_OPTIONS = [
  "discovered",
  "installed",
  "loading",
  "loaded",
  "enabling",
  "enabled",
  "disabling",
  "disabled",
  "unloading",
  "error",
  "updating",
] as const

const SOURCE_OPTIONS = ["builtin", "local", "marketplace", "git", "dev"] as const

const SORT_OPTIONS = ["name", "updated", "usage", "rating"] as const

export function PluginFilterSheet() {
  const t = useTranslations("plugins.filterSheet")
  const open = usePluginsStore((s) => s.filterSheetOpen)
  const setOpen = usePluginsStore((s) => s.setFilterSheetOpen)
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const resetFilters = usePluginsStore((s) => s.resetFilters)

  const allPermissions = Object.values(PERMISSION_GROUPS).flat()

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-4">
          <FilterField label={t("query")}>
            <Input
              value={filters.query}
              onChange={(e) => setFilters({ query: e.target.value })}
              placeholder={t("queryPlaceholder")}
            />
          </FilterField>

          <FilterField label={t("capability")}>
            <Select value={filters.capability} onValueChange={(v) => setFilters({ capability: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {CAPABILITY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("permission")}>
            <Select value={filters.permission} onValueChange={(v) => setFilters({ permission: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {allPermissions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("source")}>
            <Select value={filters.source} onValueChange={(v) => setFilters({ source: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {SOURCE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField label={t("status")}>
            <Select value={filters.status} onValueChange={(v) => setFilters({ status: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("any")}</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

          <Separator />

          <FilterField label={t("sort")}>
            <Select
              value={filters.sort}
              onValueChange={(v) => setFilters({ sort: v as (typeof SORT_OPTIONS)[number] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`sortMode.${s}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
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

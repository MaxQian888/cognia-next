"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import { useSkillPanelPrefs } from "@/hooks/skills"
import {
  clampEnabledWarnThreshold,
  SKILL_ENABLED_WARN_MAX,
  type SkillPanelPrefs,
} from "@/lib/skills/preferences"

/**
 * A labeled row hosting a switch — `label` + optional `hint`, control on the right.
 */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  testId?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-xs font-medium">{label}</p>
        {hint && <p className="text-[10px] leading-tight text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} size="sm" data-testid={testId} />
    </div>
  )
}

/**
 * A labeled row hosting a compact select.
 */
function SelectRow({
  label,
  value,
  onChange,
  children,
  ariaLabel,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children: ReactNode
  ariaLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <p className="min-w-0 text-xs font-medium">{label}</p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-36 shrink-0 text-xs" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>{children}</SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * Skills-panel preferences form — display, panel persistence, and injection
 * options. Reads the resolved prefs and writes partial patches through the
 * settings store. Shared by the header gear popover (and reusable as a
 * standalone settings card). Fully i18n-wired.
 */
export function SkillPreferencesForm({ className }: { className?: string }) {
  const t = useTranslations("skills")
  const prefs = useSkillPanelPrefs()
  const setPrefs = useSettingsStore((s) => s.setSkillPanelPrefs)

  const patch = (p: Partial<SkillPanelPrefs>) => void setPrefs(p)

  return (
    <div className={cn("flex flex-col gap-1", className)} data-testid="skill-preferences-form">
      {/* --- Display --- */}
      <GroupLabel>{t("prefs.display")}</GroupLabel>
      <SelectRow
        label={t("prefs.density")}
        value={prefs.density}
        onChange={(v) => patch({ density: v as SkillPanelPrefs["density"] })}
        ariaLabel={t("prefs.density")}
      >
        <SelectItem value="comfortable" className="text-xs">
          {t("prefs.densityComfortable")}
        </SelectItem>
        <SelectItem value="compact" className="text-xs">
          {t("prefs.densityCompact")}
        </SelectItem>
      </SelectRow>
      <SelectRow
        label={t("prefs.viewMode")}
        value={prefs.viewMode}
        onChange={(v) => patch({ viewMode: v as SkillPanelPrefs["viewMode"] })}
        ariaLabel={t("prefs.viewMode")}
      >
        <SelectItem value="list" className="text-xs">
          {t("prefs.viewList")}
        </SelectItem>
        <SelectItem value="grid" className="text-xs">
          {t("prefs.viewGrid")}
        </SelectItem>
      </SelectRow>
      <SwitchRow
        label={t("prefs.showDescription")}
        checked={prefs.showDescription}
        onChange={(v) => patch({ showDescription: v })}
        testId="pref-show-description"
      />
      <SwitchRow
        label={t("prefs.showTags")}
        checked={prefs.showTags}
        onChange={(v) => patch({ showTags: v })}
        testId="pref-show-tags"
      />
      <SwitchRow
        label={t("prefs.showSource")}
        checked={prefs.showSource}
        onChange={(v) => patch({ showSource: v })}
        testId="pref-show-source"
      />
      <SwitchRow
        label={t("prefs.showUsage")}
        checked={prefs.showUsage}
        onChange={(v) => patch({ showUsage: v })}
        testId="pref-show-usage"
      />

      <div className="my-1 border-t" />

      {/* --- Panel --- */}
      <GroupLabel>{t("prefs.panel")}</GroupLabel>
      <SelectRow
        label={t("prefs.defaultTab")}
        value={prefs.defaultTab}
        onChange={(v) => patch({ defaultTab: v as SkillPanelPrefs["defaultTab"] })}
        ariaLabel={t("prefs.defaultTab")}
      >
        <SelectItem value="my-skills" className="text-xs">
          {t("tabs.mySkills")}
        </SelectItem>
        <SelectItem value="browse" className="text-xs">
          {t("tabs.browse")}
        </SelectItem>
        <SelectItem value="editor" className="text-xs">
          {t("tabs.editor")}
        </SelectItem>
        <SelectItem value="analytics" className="text-xs">
          {t("tabs.analytics")}
        </SelectItem>
      </SelectRow>
      <SelectRow
        label={t("prefs.defaultSort")}
        value={prefs.defaultSort}
        onChange={(v) => patch({ defaultSort: v as SkillPanelPrefs["defaultSort"] })}
        ariaLabel={t("prefs.defaultSort")}
      >
        <SelectItem value="name" className="text-xs">
          {t("filter.sortName")}
        </SelectItem>
        <SelectItem value="updated" className="text-xs">
          {t("filter.sortUpdated")}
        </SelectItem>
        <SelectItem value="usage" className="text-xs">
          {t("filter.sortUsage")}
        </SelectItem>
      </SelectRow>
      <SelectRow
        label={t("prefs.defaultStatus")}
        value={prefs.defaultStatusFilter}
        onChange={(v) =>
          patch({ defaultStatusFilter: v as SkillPanelPrefs["defaultStatusFilter"] })
        }
        ariaLabel={t("prefs.defaultStatus")}
      >
        <SelectItem value="all" className="text-xs">
          {t("filter.all")}
        </SelectItem>
        <SelectItem value="enabled" className="text-xs">
          {t("status.enabled")}
        </SelectItem>
        <SelectItem value="disabled" className="text-xs">
          {t("status.disabled")}
        </SelectItem>
        <SelectItem value="error" className="text-xs">
          {t("status.error")}
        </SelectItem>
      </SelectRow>
      <SwitchRow
        label={t("prefs.rememberLastView")}
        hint={t("prefs.rememberLastViewHint")}
        checked={prefs.rememberLastView}
        onChange={(v) => patch({ rememberLastView: v })}
        testId="pref-remember-last-view"
      />

      <div className="my-1 border-t" />

      {/* --- Injection --- */}
      <GroupLabel>{t("prefs.injection")}</GroupLabel>
      <SwitchRow
        label={t("prefs.autoEnableNew")}
        hint={t("prefs.autoEnableNewHint")}
        checked={prefs.autoEnableNew}
        onChange={(v) => patch({ autoEnableNew: v })}
        testId="pref-auto-enable-new"
      />
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <Label htmlFor="skill-enabled-warn" className="text-xs font-medium">
            {t("prefs.enabledWarnThreshold")}
          </Label>
          <p className="text-[10px] leading-tight text-muted-foreground">
            {t("prefs.enabledWarnThresholdHint")}
          </p>
        </div>
        <Input
          id="skill-enabled-warn"
          type="number"
          min={0}
          max={SKILL_ENABLED_WARN_MAX}
          value={prefs.enabledWarnThreshold}
          onChange={(e) =>
            patch({ enabledWarnThreshold: clampEnabledWarnThreshold(e.target.valueAsNumber) })
          }
          className="h-7 w-20 shrink-0 text-xs"
          data-testid="pref-enabled-warn-threshold"
          aria-label={t("prefs.enabledWarnThreshold")}
        />
      </div>
    </div>
  )
}

/**
 * Header gear button that opens the preferences form in a popover. Shared entry
 * point on the skill panel header (reachable everywhere the panel renders,
 * including inside Settings).
 */
export function SkillPreferencesPopover() {
  const t = useTranslations("skills")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label={t("prefs.openAria")}
          data-testid="skill-preferences-trigger"
        >
          <SlidersHorizontalIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-80 overflow-y-auto p-3">
        <p className="mb-1 text-sm font-semibold">{t("prefs.title")}</p>
        <SkillPreferencesForm />
      </PopoverContent>
    </Popover>
  )
}

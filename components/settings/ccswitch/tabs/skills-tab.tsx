"use client"

// CCSwitch → Skills tab. Lists CCSwitch's skills table; rows whose body is
// stored externally (sourcePath set, content empty) are flagged because
// cognia-next stores skill markdown inline. Submit imports the inline
// rows via the existing `createSkill` path, skipping name collisions.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCcswitchSkills, useCcswitchStatus } from "@/lib/ccswitch/hooks"
import { importCcswitchSkills } from "@/lib/ccswitch/import"
import type { CcswitchSkill } from "@/types/ccswitch"
import { isTauri } from "@/lib/tauri"

export function CcswitchSkillsTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()
  const { data: status } = useCcswitchStatus(tabReady)
  const {
    data: skills,
    loading,
    error,
    refresh,
  } = useCcswitchSkills(tabReady && status?.exists === true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  // Default-select only inline rows; external-file rows can't be imported here.
  useEffect(() => {
    if (!skills) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default-select inline rows whenever the source data refreshes
    setSelected(new Set(skills.filter((s) => (s.content?.trim().length ?? 0) > 0).map((s) => s.id)))
  }, [skills])

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const importable = useMemo(
    () => (skills ?? []).filter((s) => selected.has(s.id) && s.content?.trim()),
    [skills, selected]
  )

  const onImport = async () => {
    if (!skills) return
    setImporting(true)
    setResultText(null)
    try {
      const r = await importCcswitchSkills(importable)
      setResultText(
        t("skills.resultSummary", {
          imported: r.imported,
          skipped: r.skipped.length,
          errored: r.errored.length,
        })
      )
    } finally {
      setImporting(false)
    }
  }

  if (!tabReady) {
    return (
      <SettingsAlert title={t("overview.webModeTitle")}>{t("overview.webModeBody")}</SettingsAlert>
    )
  }

  if (status && !status.exists) {
    return (
      <SettingsEmptyState
        title={t("overview.notFoundTitle")}
        description={t("overview.notFoundBody")}
      />
    )
  }

  if (loading) return <Skeleton className="h-32 w-full" />

  if (error) {
    return (
      <SettingsAlert variant="destructive" title={t("skills.errorTitle")}>
        {error}
      </SettingsAlert>
    )
  }

  if (!skills?.length) {
    return <SettingsEmptyState title={t("skills.emptyTitle")} description={t("skills.emptyBody")} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("skills.headerHint")}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("providers.refresh")}
        </Button>
      </div>

      <SettingsCard title={t("skills.listTitle")}>
        <ul className="divide-y">
          {skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              checked={selected.has(s.id)}
              onChange={(c) => toggle(s.id, c)}
            />
          ))}
        </ul>
      </SettingsCard>

      <div className="flex items-center justify-between">
        {resultText && <span className="text-xs text-muted-foreground">{resultText}</span>}
        <Button onClick={onImport} disabled={importing || importable.length === 0}>
          {importing ? t("skills.importing") : t("skills.importBtn", { count: importable.length })}
        </Button>
      </div>
    </div>
  )
}

function SkillRow({
  skill,
  checked,
  onChange,
}: {
  skill: CcswitchSkill
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations("ccswitch")
  const external = !(skill.content?.trim().length ?? 0)
  return (
    <li className="py-2">
      <label className={`flex items-start gap-2 ${external ? "" : "cursor-pointer"}`}>
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          disabled={external}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{skill.name}</span>
            {external && (
              <Badge variant="outline" className="text-[10px]">
                {t("skills.externalBadge")}
              </Badge>
            )}
          </div>
          {skill.description && (
            <div className="text-xs text-muted-foreground">{skill.description}</div>
          )}
          {external && skill.sourcePath && (
            <div className="text-[11px] text-muted-foreground font-mono break-all">
              {skill.sourcePath}
            </div>
          )}
        </div>
      </label>
    </li>
  )
}

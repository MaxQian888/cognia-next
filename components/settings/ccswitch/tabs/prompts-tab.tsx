"use client"

// CCSwitch → Prompts tab. Lists CCSwitch's prompts table and imports the
// selected rows as cognia-next prompt presets via `createPreset`.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCcswitchPrompts, useCcswitchStatus } from "@/lib/ccswitch/hooks"
import { importCcswitchPrompts } from "@/lib/ccswitch/import"
import type { CcswitchPrompt } from "@/types/ccswitch"
import { isTauri } from "@/lib/tauri"

export function CcswitchPromptsTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()
  const { data: status } = useCcswitchStatus(tabReady)
  const {
    data: prompts,
    loading,
    error,
    refresh,
  } = useCcswitchPrompts(tabReady && status?.exists === true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default-select all rows whenever the source data refreshes
    setSelected(new Set(prompts?.map((p) => p.id) ?? []))
  }, [prompts])

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const onImport = async () => {
    if (!prompts) return
    const picks = prompts.filter((p) => selected.has(p.id))
    setImporting(true)
    setResultText(null)
    try {
      const r = await importCcswitchPrompts(picks)
      setResultText(
        t("prompts.resultSummary", {
          imported: r.imported,
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
      <SettingsAlert variant="destructive" title={t("prompts.errorTitle")}>
        {error}
      </SettingsAlert>
    )
  }

  if (!prompts?.length) {
    return (
      <SettingsEmptyState title={t("prompts.emptyTitle")} description={t("prompts.emptyBody")} />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("prompts.headerHint")}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("providers.refresh")}
        </Button>
      </div>

      <SettingsCard title={t("prompts.listTitle")}>
        <ul className="divide-y">
          {prompts.map((p) => (
            <PromptRow
              key={p.id}
              prompt={p}
              checked={selected.has(p.id)}
              onChange={(c) => toggle(p.id, c)}
            />
          ))}
        </ul>
      </SettingsCard>

      <div className="flex items-center justify-between">
        {resultText && <span className="text-xs text-muted-foreground">{resultText}</span>}
        <Button onClick={onImport} disabled={importing || selected.size === 0}>
          {importing ? t("prompts.importing") : t("prompts.importBtn", { count: selected.size })}
        </Button>
      </div>
    </div>
  )
}

function PromptRow({
  prompt,
  checked,
  onChange,
}: {
  prompt: CcswitchPrompt
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="py-2">
      <label className="flex items-start gap-2 cursor-pointer">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{prompt.name}</div>
          {prompt.description && (
            <div className="text-xs text-muted-foreground">{prompt.description}</div>
          )}
          <div className="text-xs text-muted-foreground line-clamp-2 break-words">
            {prompt.content}
          </div>
        </div>
      </label>
    </li>
  )
}

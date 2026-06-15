"use client"

/**
 * "Review changed settings" — a dialog that diffs the current settings against
 * the canonical `DEFAULTS` and lists everything that diverges, grouped by the
 * owning section, with per-row / per-group / reset-all affordances.
 *
 * Reuses `diffFromDefaults` + `groupChangedBySection` (pure, tested in
 * `lib/settings/changed-settings.ts`) and the store's `resetSettings(keys)`.
 * Section headers reuse the existing `settings.tabs.*` labels; individual
 * setting rows fall back to a humanized key (no per-key i18n burden).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"
import {
  diffFromDefaults,
  groupChangedBySection,
  humanizeSettingKey,
  previewValue,
} from "@/lib/settings/changed-settings"
import { SETTINGS_NAV, type SettingsSectionId } from "@/components/settings/settings-nav-config"

const SECTION_LABEL_KEY: Partial<Record<SettingsSectionId, string>> = Object.fromEntries(
  SETTINGS_NAV.map((n) => [n.id, n.labelKey])
)

export function ChangedSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("settings")
  const settings = useSettingsStore((s) => s.settings)
  const resetSettings = useSettingsStore((s) => s.resetSettings)
  const [busy, setBusy] = useState(false)

  const groups = useMemo(
    () => (settings ? groupChangedBySection(diffFromDefaults(settings)) : []),
    [settings]
  )
  const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0)

  const sectionLabel = (sectionId: SettingsSectionId | undefined): string => {
    if (!sectionId) return t("changedReview.otherSection")
    const labelKey = SECTION_LABEL_KEY[sectionId]
    return labelKey ? t(`tabs.${labelKey}` as never) : sectionId
  }

  const runReset = async (keys: (keyof AppSettings)[]) => {
    setBusy(true)
    try {
      await resetSettings(keys)
      toast.success(t("changedReview.resetToast"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="changed-settings-dialog">
        <DialogHeader>
          <DialogTitle>{t("changedReview.title")}</DialogTitle>
          <DialogDescription>
            {totalCount > 0
              ? t("changedReview.count", { count: totalCount })
              : t("changedReview.description")}
          </DialogDescription>
        </DialogHeader>

        {totalCount === 0 ? (
          <p
            className="py-8 text-center text-sm text-muted-foreground"
            data-testid="changed-settings-empty"
          >
            {t("changedReview.empty")}
          </p>
        ) : (
          <ScrollArea className="max-h-[55vh] pr-3">
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.sectionId ?? "__other"} data-testid="changed-group">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{sectionLabel(group.sectionId)}</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void runReset(group.items.map((i) => i.key))}
                      data-testid="changed-group-reset"
                    >
                      <RotateCcwIcon className="mr-1.5 size-3.5" />
                      {t("changedReview.resetGroup")}
                    </Button>
                  </div>
                  <ul className="space-y-1.5">
                    {group.items.map((item) => (
                      <li
                        key={String(item.key)}
                        className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                        data-testid="changed-row"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{humanizeSettingKey(String(item.key))}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            <span className="font-mono">{previewValue(item.current)}</span>
                            <span className="mx-1.5 opacity-60">←</span>
                            <span className="font-mono opacity-70">
                              {previewValue(item.default)}
                            </span>
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void runReset([item.key])}
                          aria-label={t("changedReview.resetRowAria", {
                            name: humanizeSettingKey(String(item.key)),
                          })}
                          data-testid="changed-row-reset"
                        >
                          {t("changedReview.resetRow")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("changedReview.close")}
          </Button>
          {totalCount > 0 && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void runReset(groups.flatMap((g) => g.items.map((i) => i.key)))}
              data-testid="changed-reset-all"
            >
              <RotateCcwIcon className="mr-1.5 size-4" />
              {t("changedReview.resetAll")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

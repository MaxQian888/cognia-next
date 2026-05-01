"use client"

/**
 * Add / remove directory paths for a chat-style scheduled task. Each row
 * appears as a path input; on Tauri we offer a folder-picker button.
 *
 * The component is fully local-state-driven by its `value` prop. Empty paths
 * are dropped on commit so the resulting payload stays compact.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isTauri } from "@/lib/tauri"

export interface AdditionalDirectoriesListProps {
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
  disabled?: boolean
  testId?: string
}

export function AdditionalDirectoriesList({
  value,
  onChange,
  disabled,
  testId,
}: AdditionalDirectoriesListProps) {
  const t = useTranslations("scheduler")
  const rows = useMemo(() => value ?? [], [value])

  const setRow = useCallback(
    (index: number, next: string) => {
      const updated = [...rows]
      updated[index] = next
      onChange(updated.length === 0 ? undefined : updated)
    },
    [rows, onChange]
  )

  const addRow = useCallback(() => {
    onChange([...(rows ?? []), ""])
  }, [rows, onChange])

  const removeRow = useCallback(
    (index: number) => {
      const updated = rows.filter((_, i) => i !== index)
      onChange(updated.length === 0 ? undefined : updated)
    },
    [rows, onChange]
  )

  const pickFolder = useCallback(
    async (index: number) => {
      if (!isTauri()) return
      try {
        // Lazy-import so the web build doesn't blow up when @tauri-apps/plugin-dialog
        // isn't present.
        const dialog = await import("@tauri-apps/plugin-dialog").catch(() => null)
        if (!dialog?.open) return
        const picked = await dialog.open({ directory: true, multiple: false })
        if (typeof picked === "string" && picked) setRow(index, picked)
      } catch {
        /* user cancelled or plugin unavailable */
      }
    },
    [setRow]
  )

  return (
    <div className="space-y-2" data-testid={testId}>
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("additionalDirectories.empty")}</p>
      )}
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            value={row}
            onChange={(e) => setRow(idx, e.target.value)}
            placeholder={t("additionalDirectories.placeholder")}
            disabled={disabled}
            className="h-9 font-mono text-xs"
            data-testid={`${testId}-row-${idx}`}
          />
          {isTauri() && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => pickFolder(idx)}
              disabled={disabled}
              aria-label={t("additionalDirectories.pickFolder")}
              data-testid={`${testId}-pick-${idx}`}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => removeRow(idx)}
            disabled={disabled}
            aria-label={t("additionalDirectories.remove")}
            data-testid={`${testId}-remove-${idx}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addRow}
        disabled={disabled}
        data-testid={`${testId}-add`}
      >
        <Plus className="h-4 w-4 mr-1" />
        {t("additionalDirectories.add")}
      </Button>
    </div>
  )
}

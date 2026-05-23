"use client"

/**
 * Debounced, eager-save settings row for *non-string* inputs (Switch / Select
 * / Number / enum). The complement to `editable-field.tsx`, which stays the
 * inline editor for free-text name/description fields.
 *
 * A render-prop drives the actual control so one primitive serves every input
 * type without N wrappers. On commit it persists via `onCommit`, pings the
 * global save indicator (`markSettingsSaved`), and shows a transient "saved"
 * badge. An optional `confirmBefore` opens a `ConfirmActionDialog` when the
 * pending value matches a predicate (used for dangerous escalation changes).
 */

import { type ReactNode, useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { ConfirmActionDialog } from "./confirm-action-dialog"
import { markSettingsSaved } from "./settings-save-indicator"

export interface EditableSettingRowConfirm<T> {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  /** Only prompt when the pending value matches. Omit to always prompt. */
  predicate?: (next: T) => boolean
}

export interface EditableSettingRowProps<T> {
  label: string
  hint?: string
  value: T
  onCommit: (next: T) => void
  render: (args: { value: T; setValue: (next: T) => void; commit: () => void }) => ReactNode
  /** Trailing-edge debounce window. Default 200ms. */
  debounceMs?: number
  confirmBefore?: EditableSettingRowConfirm<T>
  testid?: string
}

export function EditableSettingRow<T>({
  label,
  hint,
  value,
  onCommit,
  render,
  debounceMs = 200,
  confirmBefore,
  testid,
}: EditableSettingRowProps<T>) {
  const t = useTranslations("agentTeamsWorkspace.settings.saveIndicator")
  // Local mirror; re-seed when the external value identity changes (cross-tab
  // / external edit) — the canonical derived-state-from-props pattern.
  const [seed, setSeed] = useState(value)
  const [local, setLocal] = useState(value)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [pending, setPending] = useState<T | null>(null)
  if (seed !== value) {
    setSeed(value)
    setLocal(value)
  }

  const persist = useCallback(
    (next: T) => {
      onCommit(next)
      markSettingsSaved()
      setSavedAt(Date.now())
    },
    [onCommit]
  )

  const commitValue = useCallback(
    (next: T) => {
      if (confirmBefore && (confirmBefore.predicate?.(next) ?? true)) {
        setPending(next)
        return
      }
      persist(next)
    },
    [confirmBefore, persist]
  )

  const debounced = useDebouncedCallback((next: T) => commitValue(next), debounceMs)

  const setValue = useCallback(
    (next: T) => {
      setLocal(next)
      debounced.call(next)
    },
    [debounced]
  )

  const commit = useCallback(() => debounced.flush(), [debounced])

  // Fade the "saved" badge after 1.5s.
  useEffect(() => {
    if (savedAt === null) return
    const id = setTimeout(() => setSavedAt(null), 1500)
    return () => clearTimeout(id)
  }, [savedAt])

  return (
    <div className="space-y-1" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        {savedAt !== null ? (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            {t("savedJustNow")}
          </Badge>
        ) : null}
      </div>
      {render({ value: local, setValue, commit })}
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}

      {confirmBefore ? (
        <ConfirmActionDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) {
              // Cancelled — revert the local mirror to the persisted value.
              setPending(null)
              setLocal(value)
            }
          }}
          title={confirmBefore.title}
          description={confirmBefore.description}
          confirmLabel={confirmBefore.confirmLabel}
          cancelLabel={confirmBefore.cancelLabel}
          tone="warning"
          onConfirm={() => {
            if (pending !== null) persist(pending)
            setPending(null)
          }}
        />
      ) : null}
    </div>
  )
}

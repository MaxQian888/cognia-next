"use client"

/**
 * Apply pack update preview dialog (ADR-0030 v50).
 *
 * Renders a two-column diff so the user can see exactly which fields
 * the new pack version will overwrite and which were preserved because
 * they edited them. The actual write happens in `applyPackUpdate` via
 * the prop callback when the user confirms.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { previewPackUpdate } from "@/lib/db/characters"
import type {
  PackUpdateDiff,
  PackUpdateFieldChange,
} from "@/lib/plugin/character-pack/diff-pack-update"

export interface CharacterPackUpdateDialogProps {
  open: boolean
  characterId: string | null
  characterName: string
  onCancel: () => void
  /** Called after the user confirms. The caller is responsible for writing. */
  onConfirm: () => Promise<void> | void
}

interface PreviewState {
  diff: PackUpdateDiff
  packVersion: string
}

export function CharacterPackUpdateDialog({
  open,
  characterId,
  characterName,
  onCancel,
  onConfirm,
}: CharacterPackUpdateDialogProps) {
  const t = useTranslations("settings.characters")
  const tDialog = useTranslations("settings.characters.applyUpdateDialog")
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open || !characterId) {
      return () => {
        setPreview(null)
      }
    }
    let cancelled = false
    void (async () => {
      const result = await previewPackUpdate(characterId)
      if (cancelled) return
      setPreview(result ?? null)
    })()
    return () => {
      cancelled = true
      setPreview(null)
    }
  }, [open, characterId])

  const confirmDisabled =
    !preview || (preview.diff.willOverwrite.length === 0 && !preview.diff.noBaseline)

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tDialog("title", { name: characterName })}</AlertDialogTitle>
          <AlertDialogDescription>{tDialog("description")}</AlertDialogDescription>
        </AlertDialogHeader>

        {preview ? (
          <div className="space-y-3">
            {preview.diff.noBaseline && (
              <p className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[11px] text-yellow-800 dark:text-yellow-200">
                {tDialog("noBaselineWarning")}
              </p>
            )}

            {preview.diff.willOverwrite.length === 0 && preview.diff.preserved.length === 0 && (
              <p className="text-xs text-muted-foreground">{tDialog("noChanges")}</p>
            )}

            {preview.diff.willOverwrite.length > 0 && (
              <DiffColumn
                heading={tDialog("willUpdate")}
                changes={preview.diff.willOverwrite}
                tone="overwrite"
                t={(field) => tDialog("fieldRow", { field })}
              />
            )}

            {preview.diff.preserved.length > 0 && (
              <DiffColumn
                heading={tDialog("preserved")}
                changes={preview.diff.preserved}
                tone="preserved"
                t={(field) => tDialog("fieldRow", { field })}
              />
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("applyUpdateNoop", { name: characterName })}
          </p>
        )}

        <AlertDialogFooter>
          {/* The Cancel button is wired through `onOpenChange(false)` below — adding
              an explicit `onClick={onCancel}` here would fire the callback twice. */}
          <AlertDialogCancel>{tDialog("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmDisabled || confirming}
            onClick={async (event) => {
              event.preventDefault()
              setConfirming(true)
              try {
                await onConfirm()
              } finally {
                setConfirming(false)
              }
            }}
          >
            {tDialog("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Convenience: render a "Apply update" button that opens the dialog.
 * The button itself is provided by the parent — this component owns
 * dialog state only.
 */
function DiffColumn({
  heading,
  changes,
  tone,
  t,
}: {
  heading: string
  changes: PackUpdateFieldChange[]
  tone: "overwrite" | "preserved"
  t: (field: string) => string
}) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-medium">{heading}</h4>
        <Badge variant="outline" className="text-[10px]">
          {changes.length}
        </Badge>
      </div>
      <ul className="space-y-1">
        {changes.map(({ field, current, next }) => (
          <li
            key={field}
            className={
              "rounded border px-2 py-1 text-[11px] " +
              (tone === "overwrite"
                ? "border-yellow-500/40 bg-yellow-500/5"
                : "border-border bg-muted/30")
            }
          >
            <p className="font-mono">{t(field)}</p>
            <p className="mt-0.5 text-muted-foreground">
              <span className="line-through">{previewValue(current)}</span>
              <span aria-hidden> → </span>
              <span>{previewValue(next)}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function previewValue(value: unknown): string {
  if (value === undefined) return "(unset)"
  if (value === null) return "null"
  if (typeof value === "string") return value.length > 80 ? value.slice(0, 80) + "…" : value
  try {
    const s = JSON.stringify(value)
    return s.length > 80 ? s.slice(0, 80) + "…" : s
  } catch {
    return String(value)
  }
}

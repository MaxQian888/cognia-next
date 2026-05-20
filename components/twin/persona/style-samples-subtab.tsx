"use client"

/**
 * Style samples subtab — list of `StyleSample` rows with per-row
 * pin/edit/delete actions and an "Add style sample" button. Pinned
 * first; remaining samples are most-recent first (descending `addedAt`).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
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
import { PinIcon, PinOffIcon } from "lucide-react"
import {
  addStyleSample,
  removeStyleSample,
  setStyleSamplePinned,
  updateStyleSample,
} from "@/lib/db/twin-profile"
import type { StyleSample } from "@/types/twin"
import { StyleSampleEditorDialog } from "./style-sample-editor-dialog"

export interface StyleSamplesSubtabProps {
  twinId: string
  styleSamples: StyleSample[]
}

function sortPinnedFirstThenRecent(a: StyleSample, b: StyleSample): number {
  const ap = a.pinned ? 1 : 0
  const bp = b.pinned ? 1 : 0
  if (ap !== bp) return bp - ap
  return b.addedAt - a.addedAt
}

export function StyleSamplesSubtab({ twinId, styleSamples }: StyleSamplesSubtabProps) {
  const t = useTranslations("twin.persona")
  const [query, setQuery] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<StyleSample | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<StyleSample | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...styleSamples].sort(sortPinnedFirstThenRecent)
    if (!q) return sorted
    return sorted.filter((s) => {
      if (s.contextLabel.toLowerCase().includes(q)) return true
      if (s.summary.toLowerCase().includes(q)) return true
      if (s.original.toLowerCase().includes(q)) return true
      if (s.tone.some((t) => t.toLowerCase().includes(q))) return true
      return false
    })
  }, [styleSamples, query])

  const openAdd = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (sample: StyleSample) => {
    setEditing(sample)
    setEditorOpen(true)
  }

  const handleSave = async (next: StyleSample) => {
    setBusy(true)
    try {
      if (editing) {
        await updateStyleSample(twinId, editing.id, next)
      } else {
        await addStyleSample(twinId, next)
      }
      setEditorOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleTogglePin = async (sample: StyleSample) => {
    await setStyleSamplePinned(twinId, sample.id, !sample.pinned)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await removeStyleSample(twinId, deleteTarget.id)
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          data-testid="style-samples-search"
          className="sm:max-w-xs"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={openAdd} data-testid="style-samples-add">
          {t("styleSample.add")}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {styleSamples.length === 0 ? t("empty.styleSamples") : t("empty.noMatch")}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((sample) => (
            <li key={sample.id} className="list-none">
              <Card
                className="flex flex-col gap-2 p-3"
                data-testid={`style-sample-row-${sample.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{sample.contextLabel}</span>
                      {sample.tone.slice(0, 3).map((tone) => (
                        <Badge key={tone} variant="outline" className="shrink-0">
                          {tone}
                        </Badge>
                      ))}
                      {sample.pinned ? (
                        <Badge variant="secondary" className="shrink-0">
                          {t("badges.pinned")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground line-clamp-2 text-xs">{sample.summary}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void handleTogglePin(sample)}
                      aria-label={sample.pinned ? t("actions.unpin") : t("actions.pin")}
                      data-testid={`style-sample-pin-${sample.id}`}
                    >
                      {sample.pinned ? (
                        <PinOffIcon className="size-4" />
                      ) : (
                        <PinIcon className="size-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEdit(sample)}
                      data-testid={`style-sample-edit-${sample.id}`}
                    >
                      {t("actions.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteTarget(sample)}
                      data-testid={`style-sample-delete-${sample.id}`}
                    >
                      {t("actions.delete")}
                    </Button>
                  </div>
                </div>
                <pre className="text-muted-foreground line-clamp-3 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                  {sample.original}
                </pre>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <StyleSampleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        sample={editing}
        onSave={handleSave}
        busy={busy}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => (o ? null : setDeleteTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("styleSample.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("styleSample.deleteConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              data-testid="style-sample-delete-confirm"
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

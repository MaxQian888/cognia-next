"use client"

/**
 * Playbooks subtab — searchable card list of `Playbook` rows with per-row
 * pin/edit/delete actions and an "Add playbook" button. Pinned first,
 * then by confidence (descending), then alphabetical.
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
  addPlaybook,
  removePlaybook,
  setPlaybookPinned,
  updatePlaybook,
} from "@/lib/db/twin-profile"
import type { Playbook } from "@/types/twin"
import { PlaybookEditorDialog } from "./playbook-editor-dialog"

export interface PlaybooksSubtabProps {
  twinId: string
  playbooks: Playbook[]
}

function sortPinnedFirstThenConfidence(a: Playbook, b: Playbook): number {
  const ap = a.pinned ? 1 : 0
  const bp = b.pinned ? 1 : 0
  if (ap !== bp) return bp - ap
  if (a.confidence !== b.confidence) return b.confidence - a.confidence
  return a.title.localeCompare(b.title)
}

export function PlaybooksSubtab({ twinId, playbooks }: PlaybooksSubtabProps) {
  const t = useTranslations("twin.persona")
  const [query, setQuery] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Playbook | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Playbook | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...playbooks].sort(sortPinnedFirstThenConfidence)
    if (!q) return sorted
    return sorted.filter((p) => {
      if (p.title.toLowerCase().includes(q)) return true
      if (p.trigger.toLowerCase().includes(q)) return true
      if (p.steps.some((s) => s.action.toLowerCase().includes(q))) return true
      return false
    })
  }, [playbooks, query])

  const openAdd = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (playbook: Playbook) => {
    setEditing(playbook)
    setEditorOpen(true)
  }

  const handleSave = async (next: Playbook) => {
    setBusy(true)
    try {
      if (editing) {
        await updatePlaybook(twinId, editing.id, next)
      } else {
        await addPlaybook(twinId, next)
      }
      setEditorOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleTogglePin = async (playbook: Playbook) => {
    await setPlaybookPinned(twinId, playbook.id, !playbook.pinned)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await removePlaybook(twinId, deleteTarget.id)
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-stretch gap-2 @sm/twin:flex-row @sm/twin:items-center">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          data-testid="playbooks-search"
          className="@sm/twin:max-w-xs"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={openAdd} data-testid="playbooks-add">
          {t("playbook.add")}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {playbooks.length === 0 ? t("empty.playbooks") : t("empty.noMatch")}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((playbook) => (
            <li key={playbook.id} className="list-none">
              <Card className="flex flex-col gap-2 p-3" data-testid={`playbook-row-${playbook.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{playbook.title}</span>
                      <Badge variant="outline" className="shrink-0">
                        {t("playbook.confidenceShort", {
                          value: Math.round(playbook.confidence * 100),
                        })}
                      </Badge>
                      {playbook.pinned ? (
                        <Badge variant="secondary" className="shrink-0">
                          {t("badges.pinned")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground line-clamp-2 text-xs">{playbook.trigger}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void handleTogglePin(playbook)}
                      aria-label={playbook.pinned ? t("actions.unpin") : t("actions.pin")}
                      data-testid={`playbook-pin-${playbook.id}`}
                    >
                      {playbook.pinned ? (
                        <PinOffIcon className="size-4" />
                      ) : (
                        <PinIcon className="size-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEdit(playbook)}
                      data-testid={`playbook-edit-${playbook.id}`}
                    >
                      {t("actions.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteTarget(playbook)}
                      data-testid={`playbook-delete-${playbook.id}`}
                    >
                      {t("actions.delete")}
                    </Button>
                  </div>
                </div>
                {playbook.steps.length > 0 ? (
                  <ol className="ml-4 list-decimal text-muted-foreground text-xs">
                    {playbook.steps.slice(0, 4).map((step) => (
                      <li key={step.order} className="line-clamp-1">
                        {step.action}
                      </li>
                    ))}
                    {playbook.steps.length > 4 ? (
                      <li className="italic">
                        {t("playbook.moreSteps", { count: playbook.steps.length - 4 })}
                      </li>
                    ) : null}
                  </ol>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <PlaybookEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        playbook={editing}
        onSave={handleSave}
        busy={busy}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => (o ? null : setDeleteTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("playbook.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("playbook.deleteConfirmBody", { title: deleteTarget?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              data-testid="playbook-delete-confirm"
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

"use client"

import { useMemo, useState } from "react"
import { PinIcon, PinOffIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { hasNoLeakingPii } from "@cognia/redact"

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
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  addDecision,
  removeDecision,
  setDecisionPinned,
  updateDecision,
} from "@/lib/db/twin-profile"
import type { DecisionRecord } from "@/types/twin"

export function DecisionsSubtab({
  twinId,
  decisions,
}: {
  twinId: string
  decisions: DecisionRecord[]
}) {
  const t = useTranslations("twin.persona")
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<DecisionRecord | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DecisionRecord | null>(null)
  const [context, setContext] = useState("")
  const [choice, setChoice] = useState("")
  const [rationale, setRationale] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...decisions]
      .sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          (b.timestamp ?? 0) - (a.timestamp ?? 0)
      )
      .filter(
        (decision) =>
          !q ||
          decision.context.toLowerCase().includes(q) ||
          decision.choice.toLowerCase().includes(q) ||
          decision.rationale.toLowerCase().includes(q)
      )
  }, [decisions, query])

  const openEditor = (decision?: DecisionRecord) => {
    setEditing(decision ?? null)
    setContext(decision?.context ?? "")
    setChoice(decision?.choice ?? "")
    setRationale(decision?.rationale ?? "")
    setError(null)
    setEditorOpen(true)
  }

  const save = async () => {
    const nextContext = context.trim()
    const nextChoice = choice.trim()
    const nextRationale = rationale.trim()
    if (!nextContext || !nextChoice) {
      setError(t("decision.required"))
      return
    }
    if (!hasNoLeakingPii([nextContext, nextChoice, nextRationale].join("\n"))) {
      setError(t("decision.piiBlocked"))
      return
    }
    setBusy(true)
    try {
      const next: DecisionRecord = {
        id: editing?.id ?? `decision_${Date.now().toString(36)}`,
        context: nextContext,
        choice: nextChoice,
        rationale: nextRationale,
        sourceChunkIds: editing?.sourceChunkIds ?? [],
        timestamp: editing?.timestamp ?? Date.now(),
        pinned: editing?.pinned ?? true,
      }
      if (editing) await updateDecision(twinId, editing.id, next)
      else await addDecision(twinId, next)
      setEditorOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 @sm/twin:flex-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          data-testid="decisions-search"
          className="@sm/twin:max-w-xs"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={() => openEditor()} data-testid="decisions-add">
          {t("decision.add")}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {decisions.length === 0 ? t("empty.decisions") : t("empty.noMatch")}
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((decision) => (
            <li key={decision.id} className="list-none">
              <Card className="flex flex-col gap-2 p-3" data-testid={`decision-row-${decision.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{decision.context}</p>
                    <p className="text-sm">{decision.choice}</p>
                    {decision.rationale ? (
                      <p className="mt-1 text-xs text-muted-foreground">{decision.rationale}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void setDecisionPinned(twinId, decision.id, !decision.pinned)}
                      aria-label={decision.pinned ? t("actions.unpin") : t("actions.pin")}
                      data-testid={`decision-pin-${decision.id}`}
                    >
                      {decision.pinned ? (
                        <PinOffIcon className="size-4" />
                      ) : (
                        <PinIcon className="size-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEditor(decision)}
                      data-testid={`decision-edit-${decision.id}`}
                    >
                      {t("actions.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteTarget(decision)}
                      data-testid={`decision-delete-${decision.id}`}
                    >
                      {t("actions.delete")}
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent data-testid="decision-editor-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? t("decision.edit") : t("decision.add")}</DialogTitle>
            <DialogDescription>{t("decision.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder={t("decision.contextPlaceholder")}
              aria-label={t("decision.contextLabel")}
              data-testid="decision-context"
            />
            <Input
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              placeholder={t("decision.choicePlaceholder")}
              aria-label={t("decision.choiceLabel")}
              data-testid="decision-choice"
            />
            <Textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder={t("decision.rationalePlaceholder")}
              aria-label={t("decision.rationaleLabel")}
              data-testid="decision-rationale"
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={busy} data-testid="decision-save">
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => (open ? null : setDeleteTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("decision.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("decision.deleteConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void removeDecision(twinId, deleteTarget.id)
                setDeleteTarget(null)
              }}
              data-testid="decision-delete-confirm"
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

"use client"

/**
 * A goal's objective, editable in place while the goal can still move
 * (ADR-0019).
 *
 * `GoalRuntime.updateObjective` existed for the `/goal update` command, the
 * plugin API, the workflow node and the companion — and for no screen. The
 * inspector now offers it: the edit starts from what the user wrote
 * (`rawObjective`), goes back through the runtime so it is redacted and the
 * in-flight turn is aborted exactly as the command does, and the model hears
 * about it on the next turn. A finished goal's objective is history; it shows
 * read-only.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, PencilIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { isTerminalGoalStatus, type Goal } from "@/types/goal"

export interface GoalObjectiveEditorProps {
  goal: Pick<Goal, "id" | "status" | "config" | "rawObjective" | "safeObjective">
}

export function GoalObjectiveEditor({ goal }: GoalObjectiveEditorProps) {
  const t = useTranslations("goal.objective")
  const controls = useGoalControls(goal)
  // On a paired phone the edit travels over `goal_update`, and only with the
  // remote-control grant.
  const editable = !isTerminalGoalStatus(goal.status) && controls.allowed
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)

  // A goal that ends while the editor is open can no longer take the edit.
  const [boundGoal, setBoundGoal] = useState(goal.id)
  if (boundGoal !== goal.id || (editing && !editable)) {
    setBoundGoal(goal.id)
    setEditing(false)
  }

  const start = () => {
    setDraft(goal.rawObjective || goal.safeObjective)
    setEditing(true)
  }

  const trimmed = draft.trim()
  const unchanged = trimmed === (goal.rawObjective || goal.safeObjective).trim()

  async function save() {
    if (!trimmed || unchanged) return
    setSaving(true)
    try {
      const outcome = await controls.updateObjective(trimmed)
      if (outcome === "updated") {
        toast.success(t("updated"))
        setEditing(false)
      } else if (outcome === "unchanged") {
        // The runtime refused: the goal ended meanwhile, or the redacted text
        // came out identical to what the model already has.
        toast.info(t("unchanged"))
        setEditing(false)
      }
      // "failed" was reported by the hook; keep the draft so it can be retried.
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="space-y-2" data-testid="goal-objective-editor">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              setEditing(false)
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void save()
            }
          }}
          rows={4}
          autoFocus
          aria-label={t("label")}
          disabled={saving}
          data-testid="goal-objective-input"
        />
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={saving || !trimmed || unchanged}
            data-testid="goal-objective-save"
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("save")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/objective flex items-start gap-2">
      <p
        className="min-w-0 flex-1 whitespace-pre-wrap text-sm font-medium leading-relaxed"
        data-testid="goal-objective-text"
      >
        {goal.safeObjective}
      </p>
      {editable ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={start}
          aria-label={t("edit")}
          data-testid="goal-objective-edit"
        >
          <PencilIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}

GoalObjectiveEditor.displayName = "GoalObjectiveEditor"

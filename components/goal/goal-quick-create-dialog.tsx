"use client"

/**
 * Quick-create dialog for the Goals console (ADR-0019 — console quick create).
 *
 * The console isn't bound to any chat session, but `createGoal` needs one. So
 * this dialog spins up a FRESH chat session, attaches the goal to it (reusing
 * the runtime so PII redaction + the session-uniqueness invariant apply), then
 * routes to the chat surface where the goal loop runs. The user can either type
 * an objective or pick a saved template.
 *
 * Renders its own "+ New Goal" trigger button so the console header just drops
 * it in.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listGoalTemplates } from "@/lib/db/goal-templates"
import { createGoalFromTemplate } from "@/lib/goal/templates"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { useSessions } from "@/hooks/chat/use-sessions"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Sentinel value for "no template" in the Select (Radix forbids empty values). */
const NO_TEMPLATE = "__none__"

export interface GoalQuickCreateDialogProps {
  className?: string
}

export function GoalQuickCreateDialog({ className }: GoalQuickCreateDialogProps) {
  const t = useTranslations("goal.quickCreate")
  const router = useRouter()
  const { create: createSession } = useSessions()
  const appSettings = useSettingsStore((s) => s.settings)
  const templates = useLiveQuery(() => listGoalTemplates(), [])

  const [open, setOpen] = useState(false)
  const [objective, setObjective] = useState("")
  const [templateId, setTemplateId] = useState<string>(NO_TEMPLATE)
  const [busy, setBusy] = useState(false)

  const usingTemplate = templateId !== NO_TEMPLATE
  const canSubmit = !busy && (usingTemplate || objective.trim().length > 0)

  function reset() {
    setObjective("")
    setTemplateId(NO_TEMPLATE)
    setBusy(false)
  }

  async function handleCreate() {
    if (!canSubmit) return
    setBusy(true)
    try {
      const session = await createSession()
      if (usingTemplate) {
        await createGoalFromTemplate({ templateId, sessionId: session.id, appSettings })
      } else {
        await getGoalRuntime().createGoal({
          sessionId: session.id,
          rawObjective: objective.trim(),
          appSettings,
        })
      }
      setOpen(false)
      reset()
      router.push("/")
    } catch {
      // Surface failure by simply re-enabling the form; the session may have
      // been created but the goal failed (e.g. IM guardrail — impossible for a
      // fresh local session, but defensive). The user can retry or cancel.
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className={className} data-testid="goal-quick-create-trigger">
          <PlusIcon className="size-4" aria-hidden />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="goal-quick-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {templates && templates.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-template">{t("templateLabel")}</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="goal-template" data-testid="goal-quick-create-template">
                  <SelectValue placeholder={t("templatePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEMPLATE}>{t("templateNone")}</SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!usingTemplate && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-objective">{t("objectiveLabel")}</Label>
              <Textarea
                id="goal-objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder={t("objectivePlaceholder")}
                rows={4}
                data-testid="goal-quick-create-objective"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canSubmit}
            data-testid="goal-quick-create-submit"
          >
            {busy && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

GoalQuickCreateDialog.displayName = "GoalQuickCreateDialog"

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
 * it in. "Run again" on a finished goal opens the same dialog controlled and
 * pre-filled with that goal's objective (`open` / `initialObjective`, with
 * `showTrigger={false}`), so re-running is an edit away, not a retype.
 *
 * The goal is created where its loop runs (`useGoalCreate`): here on the
 * desktop, on the paired desktop over `goal_create` from the mobile companion.
 * The conversation is created the same way either way (`startNewSession`
 * creates it on the paired host first). A phone without the remote-control
 * grant gets no trigger, and a dialog opened for it ("Use" on a template, Run
 * again) says why it cannot create instead of failing on submit.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"

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
import { useGoalCreate } from "@/hooks/goal/use-goal-create"
import { useSessions } from "@/hooks/chat/use-sessions"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Sentinel value for "no template" in the Select (Radix forbids empty values). */
const NO_TEMPLATE = "__none__"

export interface GoalQuickCreateDialogProps {
  className?: string
  /** Controlled open state. Omit for the self-contained trigger + dialog. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Objective the form opens with (re-running a finished goal). */
  initialObjective?: string
  /** Template the form opens with ("Use" on a template row). */
  initialTemplateId?: string
  /** Render the "+ New goal" trigger. Off when another control opens it. */
  showTrigger?: boolean
  /** Test id of the trigger; two triggers on one page must not share one. */
  triggerTestId?: string
  /** Trigger look — the header's primary button, or an outline one in a body. */
  triggerVariant?: "default" | "outline"
}

export function GoalQuickCreateDialog({
  className,
  open: openProp,
  onOpenChange,
  initialObjective = "",
  initialTemplateId = NO_TEMPLATE,
  showTrigger = true,
  triggerTestId = "goal-quick-create-trigger",
  triggerVariant = "default",
}: GoalQuickCreateDialogProps) {
  const t = useTranslations("goal.quickCreate")
  const router = useRouter()
  const { create: createSession } = useSessions()
  const goalCreate = useGoalCreate()
  const appSettings = useSettingsStore((s) => s.settings)
  const templates = useLiveQuery(() => listGoalTemplates(), [])

  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next)
    onOpenChange?.(next)
  }
  const [objective, setObjective] = useState(initialObjective)
  // A controlled dialog re-opened for another goal starts from that goal's
  // objective ("storing information from previous renders").
  const [boundObjective, setBoundObjective] = useState(initialObjective)
  if (boundObjective !== initialObjective) {
    setBoundObjective(initialObjective)
    setObjective(initialObjective)
  }
  const [templateId, setTemplateId] = useState<string>(initialTemplateId)
  const [boundTemplate, setBoundTemplate] = useState(initialTemplateId)
  if (boundTemplate !== initialTemplateId) {
    setBoundTemplate(initialTemplateId)
    setTemplateId(initialTemplateId)
  }
  const [busy, setBusy] = useState(false)

  const usingTemplate = templateId !== NO_TEMPLATE
  const canSubmit = goalCreate.allowed && !busy && (usingTemplate || objective.trim().length > 0)

  function reset() {
    setObjective(initialObjective)
    setTemplateId(initialTemplateId)
    setBusy(false)
  }

  async function handleCreate() {
    if (!canSubmit) return
    setBusy(true)
    try {
      const session = await createSession()
      await goalCreate.create(
        usingTemplate
          ? { templateId, sessionId: session.id, appSettings }
          : { rawObjective: objective.trim(), sessionId: session.id, appSettings }
      )
      setOpen(false)
      reset()
      // Straight into the new conversation, where the goal loop runs.
      router.push(`/${buildSessionHref(session.id)}`)
    } catch (err) {
      // Re-enable the form so the user can retry or cancel, and say what went
      // wrong: re-enabling alone looked like a click that did nothing. The
      // session may exist already with no goal on it (e.g. the PII gate
      // refused the objective).
      setBusy(false)
      toast.error(t("failed"), {
        description: err instanceof Error ? err.message : String(err),
      })
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
      {showTrigger && goalCreate.allowed ? (
        <DialogTrigger asChild>
          <Button
            size="sm"
            variant={triggerVariant}
            className={className}
            data-testid={triggerTestId}
          >
            <PlusIcon className="size-4" aria-hidden />
            {t("trigger")}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-md" data-testid="goal-quick-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!goalCreate.allowed ? (
            <p
              role="status"
              className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
              data-testid="goal-quick-create-not-allowed"
            >
              {t("remoteNotAllowed")}
            </p>
          ) : null}
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

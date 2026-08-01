"use client"

/**
 * Stage 5 — save disabled, try once, then turn on.
 *
 * The order matters and is the point of the stage. A generated procedure nobody
 * has run is not something to switch on for the user: it would start appearing
 * in every conversation's system prompt on the strength of a model's first
 * draft. So the skill is saved `disabled`, the trial opens a chat with *only*
 * this skill available, and enabling is a separate, explicit act.
 *
 * The trial disables every other enabled skill for that session specifically so
 * the result cannot be explained by something else — which is the only way a
 * one-shot trial tells the user anything.
 */

import { useTranslations } from "next-intl"
import { CheckCircle2, Loader2, MessageSquare, Save } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { useRecorderDraft, useRecorderPhase } from "@/hooks/skills/use-skill-recorder"

interface Props {
  onSave: () => void
  onStartTrial: () => void
  onConfirmTrial: () => void
  onOpenEditor: () => void
}

export function StageSave({ onSave, onStartTrial, onConfirmTrial, onOpenEditor }: Props) {
  const t = useTranslations("skills.recorder")
  const phase = useRecorderPhase()
  const draft = useRecorderDraft()
  const savedSkillId = useRecorderStore((state) => state.savedSkillId)
  const trialSessionId = useRecorderStore((state) => state.trialSessionId)
  const trialConfirmed = useRecorderStore((state) => state.trialConfirmed)
  const error = useRecorderStore((state) => state.error)

  const saving = phase === "saving"

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("save.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("save.description")}</p>
      </div>

      {!savedSkillId ? (
        <>
          <Button onClick={onSave} disabled={saving || !draft}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Save className="size-4" aria-hidden />
            )}
            {saving ? t("save.saving") : t("save.run")}
          </Button>
          {error?.code === "saveFailed" ? (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{t("save.failed")}</AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
            <span className="text-sm" aria-live="polite">
              {t("save.saved", { name: draft?.name ?? "" })}
            </span>
            <Badge variant="outline">{t("save.disabledNotice")}</Badge>
          </div>

          <Button size="sm" variant="ghost" onClick={onOpenEditor} className="px-2">
            {t("draft.openEditor")}
          </Button>

          <section className="space-y-2 rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t("save.trial.description")}</p>
            {!trialSessionId ? (
              <Button size="sm" onClick={onStartTrial}>
                <MessageSquare className="size-4" aria-hidden />
                {t("save.trial.start")}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs">{t("save.trial.opened")}</p>
                {trialConfirmed ? (
                  <p className="text-sm text-emerald-600 dark:text-emerald-500" aria-live="polite">
                    {t("save.trial.enabled", { name: draft?.name ?? "" })}
                  </p>
                ) : (
                  <Button size="sm" onClick={onConfirmTrial}>
                    {t("save.trial.succeeded")}
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

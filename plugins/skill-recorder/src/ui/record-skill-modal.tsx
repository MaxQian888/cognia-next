"use client"

/**
 * Recorder modal — opened by `/record-skill` via `ctx.modal.openModal`.
 * `<PluginModalRoot/>` (app/layout) renders it inside the app providers, so the
 * skill hooks/stores below resolve.
 *
 * Flow: Start → live step list → Stop → generate (LLM) → persist as a
 * `source: "generated"` skill (with screenshots as resources) → open the
 * existing Skill editor for review/refine.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { PluginModalProps } from "@/types/plugin/plugin-modal"
import { Button } from "@/components/ui/button"
import { createSkill } from "@/lib/db/skills"
import { useSkillsStore } from "@/stores/skills"
import { useSkillRecording } from "@/hooks/skills/use-skill-recording"
import { useSkillGeneration } from "@/hooks/skills/use-skill-generation"
import { buildScreenshotResources } from "@/lib/skills/recording/screenshot-resources"

export function RecordSkillModal({ onClose }: PluginModalProps) {
  const t = useTranslations("skills")
  const recording = useSkillRecording()
  const generation = useSkillGeneration()
  const [attach, setAttach] = useState(true)
  const [saving, setSaving] = useState(false)

  const isRecording = recording.status === "recording"
  const busy = generation.generating || saving || recording.status === "stopping"

  const handleStart = async () => {
    try {
      await recording.start({ inlineScreenshots: attach })
    } catch {
      // surfaced via recording.error
    }
  }

  const handleStop = async () => {
    const trace = await recording.stop()
    if (!trace || trace.observations.length === 0) {
      toast.info(t("recorder.emptyTrace"))
      return
    }
    const draft = await generation.generate(trace)
    if (!draft) return // toast handled inside the hook
    setSaving(true)
    try {
      const resources = attach ? buildScreenshotResources(trace) : undefined
      const created = await createSkill({
        name: draft.name,
        description: draft.description,
        content: draft.content,
        tags: draft.tags,
        category: draft.category,
        allowedTools: draft.allowedTools,
        source: "generated",
        resources,
      })
      toast.success(t("recorder.saved", { name: created.name }))
      useSkillsStore.getState().openSkillInEditor(created.id, draft.content)
      onClose()
    } catch {
      toast.error(t("recorder.generateFailed"))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    await recording.cancel()
    onClose()
  }

  return (
    <section
      aria-label={t("recorder.title")}
      className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col gap-4 p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("recorder.title")}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("recorder.close")}
        </Button>
      </header>

      <p className="text-sm text-muted-foreground">{t("recorder.description")}</p>

      {generation.generating ? (
        <p className="text-sm" role="status">
          {t("recorder.generating")}
        </p>
      ) : isRecording ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            {t("recorder.recording", { count: recording.steps.length })}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
            {recording.steps.map((s) => (
              <li key={s.seq} className="flex items-center gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {t(`recorder.stepKind.${s.kind}`)}
                </span>
                <span className="truncate">{s.element?.name ?? s.textHint ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={attach}
            onChange={(e) => setAttach(e.target.checked)}
            className="size-4"
          />
          {t("recorder.attachScreenshots")}
        </label>
      )}

      {recording.error && recording.error !== "desktop-only" ? (
        <p className="text-xs text-destructive">{recording.error}</p>
      ) : null}

      <footer className="flex justify-end gap-2">
        {isRecording ? (
          <>
            <Button variant="outline" onClick={handleCancel} disabled={busy}>
              {t("recorder.cancel")}
            </Button>
            <Button onClick={handleStop} disabled={busy}>
              {t("recorder.stop")}
            </Button>
          </>
        ) : (
          <Button onClick={handleStart} disabled={busy}>
            {t("recorder.start")}
          </Button>
        )}
      </footer>
    </section>
  )
}

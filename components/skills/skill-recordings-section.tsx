"use client"

/**
 * The "Recordings" tab of a skill's detail panel.
 *
 * A skill made by the recorder has a *source* — the capture it was written
 * from — and that source outlives the draft. Showing it here is what turns a
 * generated skill from something that appeared into something with a history:
 * which run produced it, what was excluded, whether a model was involved.
 *
 * Bundles live natively, so their presence is checked against the native side
 * rather than assumed from the row. A row whose capture is gone is still shown —
 * it still records provenance — but it cannot be forked.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { Skeleton } from "@/components/ui/skeleton"
import { isTauri } from "@/lib/tauri"
import {
  deleteRecording,
  duplicateRecording,
  listRecordingsForSkill,
} from "@/lib/db/skill-recordings"

import { SkillRecordingRow } from "./skill-recording-row"

interface Props {
  skillId: string
}

export function SkillRecordingsSection({ skillId }: Props) {
  const t = useTranslations("skills.recorder.versions")
  // A live query rather than a fetch-and-refetch: forking or deleting a version
  // updates the list without this component having to remember to reload.
  const rows = useLiveQuery(() => listRecordingsForSkill(skillId), [skillId])
  const [presentBundles, setPresentBundles] = useState<Set<string> | null>(null)

  useEffect(() => {
    // No native side to ask off-desktop. Treating every bundle as present would
    // offer a fork that cannot work; treating none as present would be a false
    // alarm on every row — so the check is simply not made.
    if (!isTauri()) return
    let cancelled = false
    void import("@/lib/skills/recording/recorder-client")
      .then((client) => client.recordListRecoverable())
      .then((bundles) => {
        if (!cancelled) setPresentBundles(new Set(bundles.map((b) => b.recordingId)))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [skillId])

  const handleDuplicate = useCallback(
    async (id: string) => {
      const forked = await duplicateRecording(id).catch(() => null)
      if (!forked) {
        toast.error(t("duplicateFailed"))
        return
      }
      toast.success(t("duplicated", { n: forked.versionNumber }))
    },
    [t]
  )

  const handleDelete = useCallback(async (id: string) => {
    // The bundle is left alone here. Destroying the only copy of a capture is a
    // decision of its own, and it lives on the skill-deletion dialog.
    await deleteRecording(id).catch(() => undefined)
  }, [])

  if (rows === undefined) {
    return <Skeleton className="h-24 w-full" aria-label={t("title")} />
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <section className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("immutable")}</p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <SkillRecordingRow
            key={row.id}
            recording={row}
            // Unknown means "we could not ask", and a fork that is offered and
            // works beats one that fails silently — so unknown allows it.
            bundlePresent={presentBundles === null || presentBundles.has(row.bundleId)}
            onDuplicate={(id) => void handleDuplicate(id)}
            onDelete={(id) => void handleDelete(id)}
          />
        ))}
      </ul>
    </section>
  )
}

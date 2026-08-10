"use client"

/**
 * One recorded source version of a skill.
 *
 * The row shows provenance rather than a preview: which model wrote the draft
 * (or that none did), whether redaction altered the transcript, and how much of
 * the capture survived review. That is the part a user cannot reconstruct later,
 * and the part that decides whether they trust the skill.
 *
 * "Edit as a new version" rather than "Edit": a saved version is immutable, so
 * editing forks it over the same bundle. Presenting it as an in-place edit would
 * promise something the data model deliberately refuses.
 */

import { useTranslations } from "next-intl"
import { Copy, FileWarning, ShieldCheck, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { SkillRecordingRow as RecordingRow } from "@/lib/db/skill-recordings"

interface Props {
  recording: RecordingRow
  /** False when the native bundle behind this row is gone. */
  bundlePresent: boolean
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

/** Whole KiB/MiB — an exact byte count is noise at this size. */
export function formatBundleSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SkillRecordingRow({ recording, bundlePresent, onDuplicate, onDelete }: Props) {
  const t = useTranslations("skills.recorder.versions")
  const tInterrupt = useTranslations("skills.recorder.interrupt")
  const generation = recording.generation

  return (
    <li className="flex flex-col gap-2 px-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t("versionLabel", { n: recording.versionNumber })}
        </span>
        <Badge variant="outline">{t(`status.${recording.status}`)}</Badge>
        {generation?.redacted ? (
          <Badge variant="secondary" className="gap-1">
            <ShieldCheck className="size-3" aria-hidden />
            {t("redacted")}
          </Badge>
        ) : null}
        {!bundlePresent ? (
          <Badge variant="destructive" className="gap-1">
            <FileWarning className="size-3" aria-hidden />
            {t("bundleMissing")}
          </Badge>
        ) : null}
      </div>

      {/* Plain paragraphs, not a nested list: the versions list is itself a
          `<ul>`, and nesting one inside each row makes every `listitem` query
          ambiguous for assistive technology as much as for a test. */}
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{t("stepCounts", { included: recording.includedCount, total: recording.stepCount })}</p>
        <p>{t("bundleSize", { size: formatBundleSize(recording.bundleBytes) })}</p>
        {/* A template-written draft says so rather than naming a model that
            never saw the recording. */}
        <p>
          {generation
            ? t("model", { model: `${generation.provider} · ${generation.model}` })
            : t("manual")}
        </p>
        {recording.interrupt ? <p>{tInterrupt(`reason.${recording.interrupt.reason}`)}</p> : null}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!bundlePresent}
          onClick={() => onDuplicate(recording.id)}
        >
          <Copy className="size-3.5" aria-hidden />
          {t("duplicate")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => onDelete(recording.id)}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("delete")}
        </Button>
      </div>
    </li>
  )
}

"use client"

import { toast } from "sonner"
import type { Skill } from "@/lib/claude/types"
import { serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import { pickDirectory, saveFilesToDir } from "@/lib/files/file-bridge"
import { loggers } from "@/lib/logger"

type TranslatorValues = Record<string, string | number | Date>
type Translator = (key: string, vars?: TranslatorValues) => string

export interface ExportOutcome {
  /** True if the user picked a target and the operation ran (even with partial failures). */
  ran: boolean
  writtenCount: number
  failedCount: number
  total: number
}

/**
 * Drives the "pick directory → write skills as SKILL.md → toast → log" flow
 * shared by the batch action bar, the panel toolbar, and any future caller.
 *
 * @param skills    Skills to export.
 * @param tToasts   Translator scoped to `skills.toasts`.
 * @param ctx       Free-form context (e.g. { source: "batch", count }) merged
 *                  into every log entry for traceability.
 */
export async function exportSkillsToDirWithFeedback(
  skills: Skill[],
  tToasts: Translator,
  ctx: Record<string, unknown> = {}
): Promise<ExportOutcome> {
  const total = skills.length
  if (total === 0) {
    toast.info(tToasts("noCustomToExport"))
    loggers.skills.info("export skipped — empty skill list", ctx)
    return { ran: false, writtenCount: 0, failedCount: 0, total }
  }

  const dir = await pickDirectory()
  // Browser fallback returns null but `saveFilesToDir` still triggers per-file
  // downloads in that case, so we don't bail out here.

  const files = skills.map((sk) => ({
    name: skillFilename(sk.name),
    content: serializeSkill(sk),
  }))

  const result = await saveFilesToDir(dir, files)
  const failed = result.errored.length
  const written = result.writtenCount

  if (failed > 0) {
    toast.warning(tToasts("exportedPartial", { ok: written, total: files.length, failed }))
    loggers.skills.warn("export partial", {
      ...ctx,
      ok: written,
      total: files.length,
      failed,
      errored: result.errored,
    })
  } else {
    toast.success(tToasts("exportedCount", { count: written }))
    loggers.skills.info("export ok", { ...ctx, count: written })
  }

  return { ran: true, writtenCount: written, failedCount: failed, total }
}

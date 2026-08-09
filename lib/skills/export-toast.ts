"use client"

import { toast } from "sonner"
import type { Skill } from "@cognia/agent-config-types"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { saveBinaryFileAs } from "@/lib/files/file-bridge"
import { serializeSkillsBundle } from "@/lib/skills/bundle/serializer"
import { deriveSkillSlug } from "@/lib/skills/slug"
import { loggers } from "@cognia/logging"

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
 * Drives the complete bundle zip export flow
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

  const bundles = await Promise.all(
    skills.map(async (skill) => ({ skill, resources: await listResourcesForSkill(skill.id) }))
  )
  const bytes = await serializeSkillsBundle(bundles)
  const defaultName =
    skills.length === 1
      ? `${deriveSkillSlug(skills[0])}.zip`
      : `skills-${new Date().toISOString().slice(0, 10)}.zip`
  const saved = await saveBinaryFileAs({
    defaultName,
    bytes,
    mimeType: "application/zip",
    filters: [{ name: "Skill bundle", extensions: ["zip"] }],
  })
  if (!saved) return { ran: false, writtenCount: 0, failedCount: 0, total }
  toast.success(tToasts("exportedCount", { count: total }))
  loggers.skills.info("bundle export ok", { ...ctx, count: total, defaultName })
  return { ran: true, writtenCount: total, failedCount: 0, total }
}

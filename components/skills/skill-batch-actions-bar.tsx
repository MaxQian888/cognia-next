"use client"

import { useTranslations } from "next-intl"
import { DownloadIcon, PowerIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { toast } from "sonner"
import { deleteSkill, listSkillsByIds, setSkillStatus } from "@/lib/db/skills"
import { useSkillsStore } from "@/stores/skills"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { loggers } from "@/lib/logger"

/**
 * Floating action bar shown when the user has selected one or more skills.
 * Hidden when selection is empty.
 */
export function SkillBatchActionsBar() {
  const t = useTranslations("skills.card")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const selection = useSkillsStore((s) => s.selection)
  const clear = useSkillsStore((s) => s.clearSelection)
  const count = selection.size
  if (count === 0) return null

  const ids = Array.from(selection)

  const handleEnable = async () => {
    let failed = 0
    for (const id of ids) {
      try {
        await setSkillStatus(id, "enabled")
      } catch (err) {
        failed += 1
        loggers.skills.error("batch enable failed", err, { id })
      }
    }
    toast.success(tToasts("enabledCount", { count }))
    loggers.skills.info("batch enable ok", { count, failed })
    clear()
  }

  const handleDisable = async () => {
    let failed = 0
    for (const id of ids) {
      try {
        await setSkillStatus(id, "disabled")
      } catch (err) {
        failed += 1
        loggers.skills.error("batch disable failed", err, { id })
      }
    }
    toast.success(tToasts("disabledCount", { count }))
    loggers.skills.info("batch disable ok", { count, failed })
    clear()
  }

  const handleDelete = async () => {
    let failed = 0
    for (const id of ids) {
      try {
        await deleteSkill(id)
      } catch (err) {
        failed += 1
        loggers.skills.warn("batch delete skipped", { id, error: String(err) })
      }
    }
    if (failed > 0) {
      toast.warning(tToasts("deletedPartial", { ok: count - failed, total: count }))
      loggers.skills.info("batch delete partial", { ok: count - failed, total: count, failed })
    } else {
      toast.success(tToasts("deletedCount", { count }))
      loggers.skills.info("batch delete ok", { count })
    }
    clear()
  }

  const handleExport = async () => {
    try {
      const skills = await listSkillsByIds(ids)
      await exportSkillsToDirWithFeedback(skills, tToasts, {
        source: "batch",
        requestedCount: ids.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("batch export failed", err, { count: ids.length })
    } finally {
      clear()
    }
  }

  return (
    <Card className="pointer-events-auto fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-3 py-2 shadow-lg">
      <span className="text-xs font-medium">{tCommon("selectedCount", { count })}</span>
      <span className="h-4 w-px bg-border" />
      <Button size="sm" variant="ghost" onClick={() => void handleEnable()}>
        <PowerIcon className="mr-1.5 size-3.5" />
        {t("enable")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void handleDisable()}>
        <PowerIcon className="mr-1.5 size-3.5 rotate-180" />
        {t("disable")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void handleExport()}>
        <DownloadIcon className="mr-1.5 size-3.5" />
        {tCommon("toolbar.exportAll")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleDelete()}
        className="text-destructive hover:text-destructive"
      >
        <Trash2Icon className="mr-1.5 size-3.5" />
        {t("delete")}
      </Button>
      <span className="h-4 w-px bg-border" />
      <Button size="icon" variant="ghost" onClick={clear} className="size-7">
        <XIcon className="size-3.5" />
      </Button>
    </Card>
  )
}

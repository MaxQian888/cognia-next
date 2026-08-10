"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { DownloadIcon, PowerIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { toast } from "sonner"
import { deleteSkill, listSkillsByIds, setSkillStatus, updateSkill } from "@/lib/db/skills"
import { useSkillsStore } from "@/stores/skills"
import { useChatStore } from "@/stores/chat"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { tagsAcrossSkills, unionTag, withoutTag } from "@/lib/skills/batch-tags"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { loggers } from "@cognia/logging"

/**
 * Floating action bar shown when the user has selected one or more skills.
 * Hidden when selection is empty.
 */
export function SkillBatchActionsBar() {
  const t = useTranslations("skills.card")
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const tTags = useTranslations("skills.batchTags")
  const selection = useSkillsStore((s) => s.selection)
  const clear = useSkillsStore((s) => s.clearSelection)
  const reduce = useReducedMotion()
  const count = selection.size

  const ids = Array.from(selection)
  const [newTag, setNewTag] = useState("")
  // Live tags across the current selection so the remove-chips stay in sync as
  // the user adds/removes. Keyed on the id list so it re-queries on change.
  const selectedSkills = useLiveQuery(() => listSkillsByIds(ids), [ids.join(",")]) ?? []
  const currentTags = tagsAcrossSkills(selectedSkills)

  const applyTags = async (mapTags: (tags: string[] | undefined) => string[]) => {
    let failed = 0
    for (const skill of selectedSkills) {
      try {
        await updateSkill(skill.id, { tags: mapTags(skill.tags) })
      } catch (err) {
        failed += 1
        loggers.skills.error("batch tag failed", err, { id: skill.id })
      }
    }
    if (failed > 0) toast.warning(tTags("partial", { ok: count - failed, total: count }))
  }

  const handleAddTag = async () => {
    const tag = newTag.trim()
    if (!tag) return
    await applyTags((tags) => unionTag(tags, tag))
    toast.success(tTags("added", { tag, count }))
    setNewTag("")
  }

  const handleRemoveTag = async (tag: string) => {
    await applyTags((tags) => withoutTag(tags, tag))
    toast.success(tTags("removed", { tag, count }))
  }

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
    const deleted: string[] = []
    for (const id of ids) {
      try {
        await deleteSkill(id)
        deleted.push(id)
      } catch (err) {
        failed += 1
        loggers.skills.warn("batch delete skipped", { id, error: String(err) })
      }
    }
    // Drop any deleted skills still attached ad-hoc in the composer.
    if (deleted.length > 0) useChatStore.getState().removeEphemeralSkillIds(deleted)
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
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="batch-bar"
          initial={reduce ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: 24 }}
          transition={
            reduce ? { duration: 0 } : { duration: MOBILE_DURATION.normal, ease: MOBILE_EASE }
          }
          className="pointer-events-none fixed bottom-4 left-1/2 z-30 -translate-x-1/2"
        >
          <div
            role="toolbar"
            className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1.5 border bg-popover px-3 py-2 text-popover-foreground shadow-lg"
            data-testid="skill-batch-actions-bar"
          >
            <span className="text-xs font-medium">{tCommon("selectedCount", { count })}</span>
            <Separator orientation="vertical" className="hidden h-4 sm:block" />
            <Button size="sm" variant="ghost" onClick={() => void handleEnable()}>
              <PowerIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("enable")}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void handleDisable()}>
              <PowerIcon className="size-3.5 rotate-180 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("disable")}</span>
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost">
                  <TagIcon className="size-3.5 sm:mr-1.5" />
                  <span className="hidden sm:inline">{tTags("button")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="center"
                className="w-64 space-y-2"
                data-testid="skill-batch-tags-popover"
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void handleAddTag()
                      }
                    }}
                    placeholder={tTags("addPlaceholder")}
                    className="h-8 text-xs"
                  />
                  <Button size="sm" className="h-8 shrink-0" onClick={() => void handleAddTag()}>
                    {tTags("add")}
                  </Button>
                </div>
                {currentTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {currentTags.map((tag) => (
                      <Button
                        key={tag}
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => void handleRemoveTag(tag)}
                        aria-label={tTags("removeAria", { tag })}
                        className="h-6 rounded-full text-[10px] text-muted-foreground hover:text-destructive"
                      >
                        {tag}
                        <XIcon className="size-2.5" />
                      </Button>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="ghost" onClick={() => void handleExport()}>
              <DownloadIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{tCommon("toolbar.exportAll")}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleDelete()}
              className="text-destructive hover:text-destructive"
            >
              <Trash2Icon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("delete")}</span>
            </Button>
            <Separator orientation="vertical" className="hidden h-4 sm:block" />
            <Button
              size="icon"
              variant="ghost"
              onClick={clear}
              className="size-7"
              aria-label={tCommon("filter.clear")}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

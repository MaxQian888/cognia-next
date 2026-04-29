"use client"

import { useTranslations } from "next-intl"
import { DownloadIcon, PowerIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { toast } from "sonner"
import { deleteSkill, listSkillsByIds, setSkillStatus } from "@/lib/db/skills"
import { useSkillsStore } from "@/stores/skills-store"
import { saveFilesToDir } from "@/lib/file-bridge"
import { pickDirectory } from "@/lib/file-bridge"
import { serializeSkill, skillFilename } from "@/lib/claude/skills-io"

/**
 * Floating action bar shown when the user has selected one or more skills.
 * Hidden when selection is empty.
 */
export function SkillBatchActionsBar() {
  const t = useTranslations("skills.card")
  const tCommon = useTranslations("skills")
  const selection = useSkillsStore((s) => s.selection)
  const clear = useSkillsStore((s) => s.clearSelection)
  const count = selection.size
  if (count === 0) return null

  const ids = Array.from(selection)

  const handleEnable = async () => {
    for (const id of ids) await setSkillStatus(id, "enabled")
    toast.success(`Enabled ${count} skill(s).`)
    clear()
  }
  const handleDisable = async () => {
    for (const id of ids) await setSkillStatus(id, "disabled")
    toast.success(`Disabled ${count} skill(s).`)
    clear()
  }
  const handleDelete = async () => {
    let failed = 0
    for (const id of ids) {
      try {
        await deleteSkill(id)
      } catch {
        failed += 1
      }
    }
    if (failed > 0) {
      toast.warning(`Deleted ${count - failed}/${count} (built-ins skipped).`)
    } else {
      toast.success(`Deleted ${count} skill(s).`)
    }
    clear()
  }
  const handleExport = async () => {
    const skills = await listSkillsByIds(ids)
    const dir = await pickDirectory()
    const files = skills.map((sk) => ({
      name: skillFilename(sk.name),
      content: serializeSkill(sk),
    }))
    const result = await saveFilesToDir(dir, files)
    if (result.errored.length > 0) {
      toast.warning(
        `Exported ${result.writtenCount}/${files.length} (${result.errored.length} failed).`
      )
    } else {
      toast.success(`Exported ${result.writtenCount} skill file(s).`)
    }
    clear()
  }

  return (
    <Card className="pointer-events-auto fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-3 py-2 shadow-lg">
      <span className="text-xs font-medium">{count} selected</span>
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

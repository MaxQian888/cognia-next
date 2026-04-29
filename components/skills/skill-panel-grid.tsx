"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SparklesIcon } from "lucide-react"
import { useSkillsStore } from "@/stores/skills-store"
import { duplicateSkill, setSkillStatus } from "@/lib/db/skills"
import { saveFileAs } from "@/lib/file-bridge"
import { serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import type { Skill } from "@/lib/claude/types"
import { SkillCard } from "./skill-card"

interface Props {
  skills: Skill[]
}

export function SkillPanelGrid({ skills }: Props) {
  const t = useTranslations("skills")
  const selection = useSkillsStore((s) => s.selection)
  const toggleSelection = useSkillsStore((s) => s.toggleSelection)
  const openDetail = useSkillsStore((s) => s.openDetail)
  const openEdit = useSkillsStore((s) => s.openEdit)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const setDeleteTarget = useSkillsStore((s) => s.setDeleteTarget)

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <SparklesIcon className="size-8 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">{t("panel.emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("panel.emptyHint")}</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          {t("panel.emptyAction")}
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-2 p-4 md:grid-cols-2 xl:grid-cols-3">
      {skills.map((sk) => (
        <SkillCard
          key={sk.id}
          skill={sk}
          selected={selection.has(sk.id)}
          onToggleSelect={toggleSelection}
          onOpen={openDetail}
          onEdit={openEdit}
          onDuplicate={async (s) => {
            const dup = await duplicateSkill(s.id)
            toast.success(`Duplicated as "${dup.name}".`)
          }}
          onExport={async (s) => {
            try {
              const ok = await saveFileAs({
                defaultName: skillFilename(s.name),
                content: serializeSkill(s),
                filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
              })
              if (ok) toast.success(`Exported "${s.name}".`)
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err))
            }
          }}
          onDelete={(s) => setDeleteTarget({ skillId: s.id, name: s.name })}
          onToggleStatus={async (s) => {
            const next = (s.status ?? "enabled") === "enabled" ? "disabled" : "enabled"
            await setSkillStatus(s.id, next)
          }}
        />
      ))}
    </div>
  )
}

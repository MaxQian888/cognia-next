"use client"

import { useTranslations } from "next-intl"
import { FileCodeIcon, FileTextIcon, ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Skill, SkillResource, SkillResourceKind } from "@cognia/agent-config-types"

type Selection =
  { id: "main"; kind: "main" } | { id: string; kind: "resource"; resource: SkillResource }

interface Props {
  skill: Skill
  resources: SkillResource[]
  activeFileId: string | null
  onSelect: (sel: Selection) => void
}

const KIND_LABEL: Record<SkillResourceKind, string> = {
  script: "scripts/",
  reference: "references/",
  asset: "assets/",
}

const KIND_ORDER: SkillResourceKind[] = ["script", "reference", "asset"]

export function SkillFileTree({ skill, resources, activeFileId, onSelect }: Props) {
  const t = useTranslations("skills.editor")
  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: resources.filter((r) => r.kind === kind),
  })).filter((g) => g.items.length > 0)

  return (
    <nav
      data-testid="skill-file-tree"
      data-skill-id={skill.id}
      className="space-y-2 px-2 py-3 text-xs"
      aria-label={t("fileTreeAria")}
    >
      <TreeRow
        active={activeFileId === "main"}
        onClick={() => onSelect({ id: "main", kind: "main" })}
        icon={<FileTextIcon className="size-3.5" />}
        label="SKILL.md"
      />
      {grouped.map((g) => (
        <div key={g.kind}>
          <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {KIND_LABEL[g.kind]}
          </div>
          {g.items.map((r) => (
            <TreeRow
              key={r.id}
              active={activeFileId === r.id}
              onClick={() => onSelect({ id: r.id, kind: "resource", resource: r })}
              icon={
                r.kind === "asset" ? (
                  <ImageIcon className="size-3.5" />
                ) : (
                  <FileCodeIcon className="size-3.5" />
                )
              }
              label={r.path.split("/").slice(-1)[0] ?? r.path}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}

function TreeRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted",
        active && "bg-muted font-medium"
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { SparklesIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { listSkillsByIds } from "@/lib/db/skills"

interface Props {
  ids: string[]
  onRemove: (id: string) => void
}

/**
 * Chip strip rendered above the composer input when one or more ephemeral
 * skills are attached for the next send. Each chip is removable.
 */
export function SkillChipRow({ ids, onRemove }: Props) {
  const t = useTranslations("skills.composer.skillPicker")
  const rows =
    useLiveQuery(() => (ids.length > 0 ? listSkillsByIds(ids) : Promise.resolve([])), [ids]) ?? []
  if (ids.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2">
      {rows.map(
        (s) =>
          s && (
            <Badge key={s.id} variant="secondary" className="gap-1">
              <SparklesIcon className="size-3" />
              <span>{s.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeChip", { name: s.name })}
                className="ml-1 size-4 rounded p-0 hover:bg-destructive/20"
                onClick={() => onRemove(s.id)}
              >
                <XIcon className="size-3" />
              </Button>
            </Badge>
          )
      )}
    </div>
  )
}

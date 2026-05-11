"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, SparklesIcon } from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { listSkills } from "@/lib/db/skills"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string[]
  onChange: (ids: string[]) => void
}

/**
 * Multi-select command dialog for attaching one or more skills to the next
 * outgoing message. Modeled on `components/chat/character-picker.tsx`.
 * Filters to enabled, non-builtin skills.
 */
export function SkillPicker({ open, onOpenChange, value, onChange }: Props) {
  const t = useTranslations("skills.composer.skillPicker")
  const skills = useLiveQuery(() => listSkills(), []) ?? []
  const visible = skills.filter((s) => !s.isBuiltIn && (s.status ?? "enabled") === "enabled")

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("searchPlaceholder")} />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        <CommandGroup heading={t("groupHeading")}>
          {visible.map((s) => (
            <CommandItem
              key={s.id}
              value={`${s.name} ${s.description ?? ""}`}
              onSelect={() => toggle(s.id)}
            >
              <SparklesIcon className="mr-2 size-4" />
              <span className="flex-1">{s.name}</span>
              {value.includes(s.id) && <CheckIcon className="size-4" />}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

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
  // Only observe the (whole) skills table while the dialog is open — the
  // picker stays mounted for the toolbar trigger, and the table is written on
  // every send (usage telemetry), so an always-on liveQuery would re-render
  // the closed dialog on each message.
  const skills = useLiveQuery(() => (open ? listSkills() : Promise.resolve([])), [open]) ?? []
  const enabled = skills.filter((s) => (s.status ?? "enabled") === "enabled")
  const custom = enabled.filter((s) => !s.isBuiltIn)
  const builtin = enabled.filter((s) => s.isBuiltIn)

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const renderItem = (s: (typeof enabled)[number]) => (
    <CommandItem
      key={s.id}
      value={`${s.name} ${s.description ?? ""}`}
      onSelect={() => toggle(s.id)}
    >
      <SparklesIcon className="mr-2 size-4" />
      <span className="flex-1">{s.name}</span>
      {value.includes(s.id) && <CheckIcon className="size-4" />}
    </CommandItem>
  )

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
        {custom.length > 0 && (
          <CommandGroup heading={t("groupHeading")}>{custom.map(renderItem)}</CommandGroup>
        )}
        {builtin.length > 0 && (
          <CommandGroup heading={t("builtinGroupHeading")}>{builtin.map(renderItem)}</CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

"use client"

import { useTranslations } from "next-intl"
import { CheckIcon, SparklesIcon } from "lucide-react"
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { useLiveQueryState } from "@/hooks/ui/use-live-query-state"
import { listSkills } from "@/lib/db/skills"

interface SkillPickerContentProps {
  /** Live-reads the skills table only while this is `true`. */
  active: boolean
  value: string[]
  onChange: (ids: string[]) => void
}

/**
 * The searchable grouped skill list, without its container — the composer's
 * skills flyout renders it inside its own `Command` + `Popover` (see
 * `components/chat/composer/skills-menu-entry.tsx`). Multi-select: picking a
 * row toggles its id in `value`.
 */
export function SkillPickerContent({ active, value, onChange }: SkillPickerContentProps) {
  const t = useTranslations("skills.composer.skillPicker")
  // Only observe the (whole) skills table while the host is open — the
  // picker stays mounted inside the composer's `+` menu row, and the table is
  // written on every send (usage telemetry), so an always-on liveQuery would
  // re-render the closed flyout on each message.
  // `?? []` here used to collapse "not read yet" into "there are none", so the
  // flyout opened onto its "no skills" copy and then popped the list in.
  const { data: skills, isLoading } = useLiveQueryState(
    () => (active ? listSkills() : Promise.resolve([])),
    [active]
  )
  const enabled = (skills ?? []).filter((s) => (s.status ?? "enabled") === "enabled")
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
    <>
      <CommandInput placeholder={t("searchPlaceholder")} />
      <CommandList>
        {/* Suppressed while the read is in flight — cmdk renders this whenever
            no items match, which during load is "not yet" rather than "none". */}
        {isLoading ? null : <CommandEmpty>{t("empty")}</CommandEmpty>}
        {custom.length > 0 && (
          <CommandGroup heading={t("groupHeading")}>{custom.map(renderItem)}</CommandGroup>
        )}
        {builtin.length > 0 && (
          <CommandGroup heading={t("builtinGroupHeading")}>{builtin.map(renderItem)}</CommandGroup>
        )}
      </CommandList>
    </>
  )
}

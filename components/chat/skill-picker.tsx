"use client"

import { useTranslations } from "next-intl"
import { CheckIcon, SparklesIcon } from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { useLiveQueryState } from "@/hooks/ui/use-live-query-state"
import { usePluginSkills } from "@/hooks/skills/use-plugin-skills"
import { listSkills } from "@/lib/db/skills"
import { cn } from "@/lib/utils"

/**
 * Where the list is drawn. `popover` is the desktop flyout's dense list;
 * `sheet` is the mobile `+` sheet's drilled-in panel — thumb-sized rows and a
 * field big enough to tap (see {@link SkillPickerPanel}).
 */
export type SkillPickerVariant = "popover" | "sheet"

interface SkillPickerContentProps {
  /** Live-reads the skills table only while this is `true`. */
  active: boolean
  value: string[]
  onChange: (ids: string[]) => void
  /** Presentation only; selection behaves the same in both. Default `popover`. */
  variant?: SkillPickerVariant
}

/**
 * Sheet rows: the 44pt floor, `active:` feedback (a phone has no hover), and
 * NO resting highlight. cmdk always marks its first match as the keyboard
 * target (`data-selected`), which on a touch list read as "already picked" on a
 * row the user never touched — the tick is what says picked. The target only
 * shows while the search field has focus, i.e. while there is a keyboard for
 * Enter to come from. Important-flagged so it beats the reset regardless of
 * the order Tailwind emits the two variants in.
 */
const SHEET_ITEM_CLASS =
  "touch-target gap-3 rounded-control px-2 active:bg-muted/60 data-[selected=true]:bg-transparent data-[selected=true]:text-foreground group-focus-within/skill-sheet:data-[selected=true]:bg-accent! group-focus-within/skill-sheet:data-[selected=true]:text-accent-foreground!"

/**
 * The searchable grouped skill list, without its container — the composer's
 * skills flyout renders it inside its own `Command` + `Popover` (see
 * `components/chat/composer/skills-menu-entry.tsx`). Multi-select: picking a
 * row toggles its id in `value`.
 */
export function SkillPickerContent({
  active,
  value,
  onChange,
  variant = "popover",
}: SkillPickerContentProps) {
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
  // Skills contributed by enabled plugins. Picking one puts its registry id in
  // the session's ephemeral skills, which the send path resolves through the
  // plugin skill registry.
  const pluginSkills = usePluginSkills("session", active)

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const sheet = variant === "sheet"

  const renderItem = (s: { id: string; name: string; description?: string }) => {
    const picked = value.includes(s.id)
    return (
      <CommandItem
        key={s.id}
        value={`${s.name} ${s.description ?? ""} ${s.id}`}
        onSelect={() => toggle(s.id)}
        className={sheet ? SHEET_ITEM_CLASS : undefined}
        data-picked={picked || undefined}
      >
        <SparklesIcon className={sheet ? "size-4" : "mr-2 size-4"} />
        <span className={sheet ? "min-w-0 flex-1 truncate" : "flex-1"}>{s.name}</span>
        {picked && <CheckIcon className={sheet ? "size-4 text-primary" : "size-4"} />}
      </CommandItem>
    )
  }

  return (
    <>
      {/* No `autoFocus`, in either presentation: the desktop flyout's Popover
          focuses its first field on open by itself, and the sheet must NOT —
          a focused field on a phone is a raised keyboard. 16px text there so
          iOS does not zoom the page when the user does tap in. */}
      <CommandInput
        placeholder={t("searchPlaceholder")}
        className={sheet ? "text-base" : undefined}
      />
      <CommandList
        className={sheet ? "max-h-none min-h-0 flex-1 overscroll-contain pb-1" : undefined}
      >
        {/* Suppressed while the read is in flight — cmdk renders this whenever
            no items match, which during load is "not yet" rather than "none". */}
        {isLoading ? null : <CommandEmpty>{t("empty")}</CommandEmpty>}
        {custom.length > 0 && (
          <CommandGroup heading={t("groupHeading")}>{custom.map(renderItem)}</CommandGroup>
        )}
        {builtin.length > 0 && (
          <CommandGroup heading={t("builtinGroupHeading")}>{builtin.map(renderItem)}</CommandGroup>
        )}
        {pluginSkills.length > 0 && (
          <CommandGroup heading={t("pluginGroupHeading")}>
            {pluginSkills.map(renderItem)}
          </CommandGroup>
        )}
      </CommandList>
    </>
  )
}

/**
 * The picker as the mobile `+` sheet's drilled-in panel (the composer's skills
 * row, `skills-menu-entry.tsx`, portals it into the sheet). A fixed height so
 * the search field stays put and the LIST scrolls inside the sheet; `min-h-0`
 * lets it give way when the sheet is shorter than that (a raised keyboard).
 * The search field is a filled, rounded 44px field that is never focused for
 * the user — tapping it is how they ask for the keyboard.
 */
export function SkillPickerPanel(props: Omit<SkillPickerContentProps, "variant">) {
  return (
    <Command
      className={cn(
        "group/skill-sheet h-[min(26rem,60dvh)] min-h-0 rounded-none bg-transparent text-foreground",
        "**:data-[slot=command-input-wrapper]:mx-1 **:data-[slot=command-input-wrapper]:mb-1 **:data-[slot=command-input-wrapper]:h-11 **:data-[slot=command-input-wrapper]:shrink-0 **:data-[slot=command-input-wrapper]:rounded-control **:data-[slot=command-input-wrapper]:border-0 **:data-[slot=command-input-wrapper]:bg-muted/60"
      )}
      data-testid="skill-picker-panel"
    >
      <SkillPickerContent {...props} variant="sheet" />
    </Command>
  )
}

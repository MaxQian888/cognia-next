"use client"

// The skills entry inside the `+` menu's capability group. Picks write the
// per-session ephemeral-skill store and ride only the next send. Where the
// list opens depends on the host menu:
//
// - Desktop attach Popover: a flyout (right of the row on a wide screen,
//   stacked above it on a narrow one; see `useFlyoutPlacement`) with the skill
//   list inline rather than a modal — toggles land instantly with no dialog
//   round-trip, and the attach menu stays open behind it (Radix tracks nested
//   layers).
// - Mobile plus-menu sheet: the sheet DRILLS IN to the list (title + back in
//   the sheet's header, see `ComposerMenuPanel`) instead of floating a popover
//   over itself, and the search field is left unfocused so the keyboard stays
//   down until the user taps it.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Command } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CapabilityRow } from "@/components/chat/composer/capability-row"
import { SkillPickerContent, SkillPickerPanel } from "@/components/chat/skill-picker"
import { useChatStore, useComposerEphemeralSkillIds } from "@/stores/chat/chat-store"
import { cn } from "@/lib/utils"
import { ComposerMenuPanel, useComposerMenuPanels } from "./composer-menu-context"
import { useFlyoutPlacement } from "./use-flyout-placement"
import type { ChatSession } from "@cognia/agent-config-types"

/** The id this entry's panel goes by in a host sheet. */
export const SKILLS_MENU_PANEL_ID = "skills"

export function SkillsMenuEntry({
  session,
  disabled,
}: {
  session?: ChatSession | null
  disabled?: boolean
}) {
  const tSkill = useTranslations("skills.composer.skillPicker")
  const sessionId = session?.id ?? null
  const ids = useComposerEphemeralSkillIds(sessionId) ?? []
  const setEphemeralSkillIds = useChatStore((s) => s.setEphemeralSkillIds)
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const { className: flyoutClassName, ...placement } = useFlyoutPlacement()
  const panels = useComposerMenuPanels()
  const onChange = (next: string[]) => setEphemeralSkillIds(next, sessionId)

  const row = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <CapabilityRow
      icon={<SparklesIcon className="size-4" />}
      label={tSkill("trigger")}
      chevron
      active={ids.length > 0}
      aria-label={tSkill("trigger")}
      disabled={disabled}
      data-testid="composer-skill-trigger"
      {...props}
    />
  )

  if (panels) {
    const panelOpen = panels.activePanelId === SKILLS_MENU_PANEL_ID
    return (
      <>
        {row({
          "aria-haspopup": "dialog",
          "aria-expanded": panelOpen,
          onClick: () => panels.openPanel(SKILLS_MENU_PANEL_ID, tSkill("trigger")),
        })}
        <ComposerMenuPanel id={SKILLS_MENU_PANEL_ID}>
          <SkillPickerPanel active={panelOpen} value={ids} onChange={onChange} />
        </ComposerMenuPanel>
      </>
    )
  }

  return (
    <Popover open={flyoutOpen} onOpenChange={setFlyoutOpen}>
      <PopoverTrigger asChild>{row({})}</PopoverTrigger>
      <PopoverContent
        {...placement}
        className={cn("w-72 p-0", flyoutClassName)}
        data-testid="composer-skill-flyout"
      >
        <Command>
          <SkillPickerContent active={flyoutOpen} value={ids} onChange={onChange} />
        </Command>
      </PopoverContent>
    </Popover>
  )
}

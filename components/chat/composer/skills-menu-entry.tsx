"use client"

// The skills entry inside the `+` menu's capability group. The row opens a
// right-side flyout with the skill list inline rather than a modal — toggles
// land instantly with no dialog round-trip, and the attach menu stays open
// behind it (Radix tracks nested layers). Picks write the per-session
// ephemeral-skill store and ride only the next send.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Command } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CapabilityRow } from "@/components/chat/composer/capability-row"
import { SkillPickerContent } from "@/components/chat/skill-picker"
import { useChatStore, useComposerEphemeralSkillIds } from "@/stores/chat/chat-store"
import type { ChatSession } from "@cognia/agent-config-types"

export function SkillsMenuEntry({
  session,
  disabled,
}: {
  session?: ChatSession | null
  disabled?: boolean
}) {
  const tSkill = useTranslations("skills.composer.skillPicker")
  const ids = useComposerEphemeralSkillIds(session?.id ?? null) ?? []
  const setEphemeralSkillIds = useChatStore((s) => s.setEphemeralSkillIds)
  const [flyoutOpen, setFlyoutOpen] = useState(false)

  return (
    <Popover open={flyoutOpen} onOpenChange={setFlyoutOpen}>
      <PopoverTrigger asChild>
        <CapabilityRow
          icon={<SparklesIcon className="size-4" />}
          label={tSkill("trigger")}
          chevron
          active={ids.length > 0}
          aria-label={tSkill("trigger")}
          disabled={disabled}
          data-testid="composer-skill-trigger"
        />
      </PopoverTrigger>
      <PopoverContent align="start" side="right" sideOffset={8} className="w-72 p-0">
        <Command>
          <SkillPickerContent
            active={flyoutOpen}
            value={ids}
            onChange={(next) => setEphemeralSkillIds(next, session?.id ?? null)}
          />
        </Command>
      </PopoverContent>
    </Popover>
  )
}

"use client"

import { useTranslations } from "next-intl"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { Character } from "@/lib/claude/types"
import { useCharacters } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (character: Character) => void
}

/**
 * Searchable command-palette-style picker for the user to choose a character
 * to start a new chat with. Mounted by `<DiscordShell>`; opens whenever the
 * user clicks "+ New chat" under Direct Messages or hits the empty-state
 * button.
 */
export function CharacterPicker({ open, onOpenChange, onPick }: Props) {
  const t = useTranslations("chat.characterPicker")
  const characters = useCharacters() ?? []

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
          {characters.map((c) => (
            <CommandItem
              key={c.id}
              value={`${c.name} ${c.description ?? ""}`}
              onSelect={() => {
                onPick(c)
                onOpenChange(false)
              }}
            >
              <span
                className="flex size-6 items-center justify-center rounded-full text-xs"
                style={{
                  backgroundColor: avatarColor(c),
                  color: "white",
                }}
                aria-hidden
              >
                {avatarGlyph(c)}
              </span>
              <span className="flex flex-col">
                <span className="text-sm">{c.name}</span>
                {c.description && (
                  <span className="line-clamp-1 text-[11px] text-muted-foreground">
                    {c.description}
                  </span>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

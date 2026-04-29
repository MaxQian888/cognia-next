"use client"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { listCharacters } from "@/lib/db/characters"
import type { Character } from "@/lib/claude/types"
import { useLiveQuery } from "dexie-react-hooks"
import { avatarColor, avatarGlyph } from "@/lib/avatar"

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
  const characters =
    useLiveQuery<Character[]>(
      () => (typeof window === "undefined" ? Promise.resolve([]) : listCharacters()),
      []
    ) ?? []

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pick a character"
      description="Each character has its own system prompt, model, and tools."
    >
      <CommandInput placeholder="Search characters…" />
      <CommandList>
        <CommandEmpty>No characters match.</CommandEmpty>
        <CommandGroup heading="Characters">
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

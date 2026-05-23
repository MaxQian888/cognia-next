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
import { isOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"
import { LOCAL_PACK_PLUGIN_ID } from "@/lib/plugin/character-pack/local-pack-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (character: Character) => void
}

/**
 * Three-bucket grouping for the picker (ADR-0030). Built-ins first, then
 * one group per plugin / local-pack source, then user-created last. The
 * `<CommandInput>` filters across all groups so the user can still type
 * to find a character without thinking about source.
 */
interface GroupedCharacters {
  builtIn: Character[]
  byPlugin: Map<string, Character[]>
  user: Character[]
}

function groupCharacters(characters: Character[]): GroupedCharacters {
  const builtIn: Character[] = []
  const byPlugin = new Map<string, Character[]>()
  const user: Character[] = []
  for (const c of characters) {
    if (c.isBuiltIn) {
      builtIn.push(c)
      continue
    }
    if (isOverlayCharacterId(c.id) && c.sourcePluginId) {
      const list = byPlugin.get(c.sourcePluginId) ?? []
      list.push(c)
      byPlugin.set(c.sourcePluginId, list)
      continue
    }
    if (isOverlayCharacterId(c.id) && !c.sourcePluginId) {
      // Anonymous overlay (shouldn't happen in practice — locally-imported
      // packs tag pluginId = LOCAL_PACK_PLUGIN_ID). Treat as local-file.
      const list = byPlugin.get(LOCAL_PACK_PLUGIN_ID) ?? []
      list.push(c)
      byPlugin.set(LOCAL_PACK_PLUGIN_ID, list)
      continue
    }
    user.push(c)
  }
  return { builtIn, byPlugin, user }
}

/**
 * Searchable command-palette-style picker for the user to choose a character
 * to start a new chat with. Mounted by `<DesktopChatWorkspace>`; opens
 * whenever the user clicks "+ New chat" under Direct Messages or hits the
 * empty-state button.
 *
 * ADR-0030 — characters are split into Built-in / per-plugin / user
 * groups; search runs cross-group through `CommandInput`'s built-in
 * filter.
 */
export function CharacterPicker({ open, onOpenChange, onPick }: Props) {
  const t = useTranslations("chat.characterPicker")
  const characters = useCharacters() ?? []
  const plugins = usePluginStore((s) => s.plugins)
  const groups = groupCharacters(characters)

  const renderItem = (c: Character) => (
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
          <span className="line-clamp-1 text-[11px] text-muted-foreground">{c.description}</span>
        )}
      </span>
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
        {groups.builtIn.length > 0 && (
          <CommandGroup heading={t("groupBuiltIn")}>{groups.builtIn.map(renderItem)}</CommandGroup>
        )}
        {Array.from(groups.byPlugin.entries()).map(([pluginId, list]) => {
          const heading =
            pluginId === LOCAL_PACK_PLUGIN_ID
              ? t("groupLocalFile")
              : t("groupPlugin", { name: plugins[pluginId]?.manifest?.name ?? pluginId })
          return (
            <CommandGroup key={pluginId} heading={heading}>
              {list.map(renderItem)}
            </CommandGroup>
          )
        })}
        {groups.user.length > 0 && (
          <CommandGroup heading={t("groupUser")}>{groups.user.map(renderItem)}</CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

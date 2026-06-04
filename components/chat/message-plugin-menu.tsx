"use client"

/**
 * Hover dropdown surfacing plugin-contributed context-menu items that
 * target the `chat:message` zone (`ctx.contextMenu.register`). Renders
 * nothing when no plugin contributed items, so messages pay zero cost in
 * the common case.
 *
 * Click dispatch goes through the `plugin-context-menu:<id>` CustomEvent
 * contract — the handlers plugins attached at registration fire unchanged.
 */

import { MoreHorizontalIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  firePluginContextMenuItem,
  isContextMenuItemDisabled,
  usePluginContextMenuItems,
} from "@/hooks/plugins/use-plugin-context-menu-items"
import type { ContextMenuClickContext } from "@/types/plugin"

export function MessagePluginMenu({
  messageId,
  sessionId,
  selection,
}: {
  messageId: string
  sessionId?: string
  selection?: string
}) {
  const t = useTranslations("chat.message")
  const items = usePluginContextMenuItems("chat:message")
  if (items.length === 0) return null

  const clickContext: ContextMenuClickContext = {
    target: "chat:message",
    messageId,
    sessionId,
    selection,
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("pluginMenu")}
          className="size-6"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        {items.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            disabled={isContextMenuItemDisabled(entry, clickContext)}
            onSelect={() => firePluginContextMenuItem(entry, clickContext)}
          >
            {entry.item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

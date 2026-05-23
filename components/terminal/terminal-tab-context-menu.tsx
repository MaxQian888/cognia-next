"use client"

/**
 * Right-click menu for a single terminal tab. Built on shadcn
 * `ContextMenu` (Radix wrapper) so semantics + portal placement match
 * the rest of the app.
 *
 * The menu is rendered as a *trigger wrapper* — pass the children that
 * own right-click affordance (typically the active tab body) and the
 * row this menu pertains to.
 *
 * Actions:
 *   * Rename       — enters rename mode in the parent (caller decides).
 *   * Restart      — kills + respawns with the same shell + cwd + agent.
 *   * Close        — calls onClose (same as ×).
 *   * Close Others — closes every other tab in the same project.
 *   * Trust Agent  — toggles `agentTrusted` (Wave 3D consumes this).
 */

import type { ReactNode } from "react"

import { useTranslations } from "next-intl"

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"

export interface TerminalTabContextMenuProps {
  row: TerminalSessionRow
  /** Wrapped children (typically the tab body) the user right-clicks on. */
  children: ReactNode
  onRename: (id: string) => void
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onToggleAgentTrust: (id: string, trusted: boolean) => void
  /** Jump to the chat session that spawned this tab. Shown only for agent-spawned tabs. */
  onLocateInChat?: (chatSessionId: string) => void
}

export function TerminalTabContextMenu({
  row,
  children,
  onRename,
  onRestart,
  onClose,
  onCloseOthers,
  onToggleAgentTrust,
  onLocateInChat,
}: TerminalTabContextMenuProps) {
  const t = useTranslations("terminal.tab.menu")
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="terminal-tab-menu" className="w-44">
        <ContextMenuItem onSelect={() => onRename(row.id)} data-testid="terminal-tab-menu-rename">
          {t("rename")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRestart(row.id)} data-testid="terminal-tab-menu-restart">
          {t("restart")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(row.id)} data-testid="terminal-tab-menu-close">
          {t("close")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onCloseOthers(row.id)}
          data-testid="terminal-tab-menu-close-others"
        >
          {t("closeOthers")}
        </ContextMenuItem>
        {row.agentSpawner && onLocateInChat ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onLocateInChat(row.agentSpawner!)}
              data-testid="terminal-tab-menu-locate"
            >
              {t("locateInChat")}
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={row.agentTrusted}
          onCheckedChange={(checked) => onToggleAgentTrust(row.id, checked === true)}
          data-testid="terminal-tab-menu-trust"
        >
          {t("trustAgent")}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default TerminalTabContextMenu

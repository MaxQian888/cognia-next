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
 *   * Appearance   — a submenu holding the colour + icon grids. A submenu
 *                    rather than an item that opens a popover: a `Popover`
 *                    nested inside a Radix context menu fights it for focus
 *                    and for the dismiss gesture, and the menu already
 *                    provides a positioned, keyboard-navigable surface.
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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"
import type { TabColorPreset, TabIconPreset } from "@/lib/terminal/tab-appearance"

import { TerminalTabAppearancePicker } from "./terminal-tab-appearance-picker"

export interface TerminalTabContextMenuProps {
  row: TerminalSessionRow
  /** Wrapped children (typically the tab body) the user right-clicks on. */
  children: ReactNode
  onRename: (id: string) => void
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onToggleAgentTrust: (id: string, trusted: boolean) => void
  /**
   * Commit a colour / icon change for this tab. Omit to drop the submenu —
   * the body menu on the terminal instance offers it too, so both mounts pass
   * it and there is no surface where the row is unknown.
   */
  onChangeAppearance?: (
    id: string,
    appearance: { color?: TabColorPreset; icon?: TabIconPreset }
  ) => void
  /** Jump to the chat session that spawned this tab. Shown only for agent-spawned tabs. */
  onLocateInChat?: (chatSessionId: string, messageId?: string | null) => void
  /**
   * Clipboard / edit actions on the focused pane. When provided, an edit
   * group (Copy / Paste / Select all / Clear / Find) renders at the top of
   * the menu — the dock wires these to the focused `TerminalInstanceHandle`.
   * Omitted by callers that only want tab-level actions.
   */
  onCopy?: () => void
  onPaste?: () => void
  onSelectAll?: () => void
  onClear?: () => void
  onFind?: () => void
}

export function TerminalTabContextMenu({
  row,
  children,
  onRename,
  onRestart,
  onClose,
  onCloseOthers,
  onToggleAgentTrust,
  onChangeAppearance,
  onLocateInChat,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onFind,
}: TerminalTabContextMenuProps) {
  const t = useTranslations("terminal.tab.menu")
  const hasEditGroup = !!(onCopy || onPaste || onSelectAll || onClear || onFind)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="terminal-tab-menu" className="w-44">
        {hasEditGroup ? (
          <>
            {onCopy ? (
              <ContextMenuItem onSelect={() => onCopy()} data-testid="terminal-tab-menu-copy">
                {t("copy")}
              </ContextMenuItem>
            ) : null}
            {onPaste ? (
              <ContextMenuItem onSelect={() => onPaste()} data-testid="terminal-tab-menu-paste">
                {t("paste")}
              </ContextMenuItem>
            ) : null}
            {onSelectAll ? (
              <ContextMenuItem
                onSelect={() => onSelectAll()}
                data-testid="terminal-tab-menu-select-all"
              >
                {t("selectAll")}
              </ContextMenuItem>
            ) : null}
            {onClear ? (
              <ContextMenuItem onSelect={() => onClear()} data-testid="terminal-tab-menu-clear">
                {t("clear")}
              </ContextMenuItem>
            ) : null}
            {onFind ? (
              <ContextMenuItem onSelect={() => onFind()} data-testid="terminal-tab-menu-find">
                {t("find")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onSelect={() => onRename(row.id)} data-testid="terminal-tab-menu-rename">
          {t("rename")}
        </ContextMenuItem>
        {onChangeAppearance ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="terminal-tab-menu-appearance">
              {t("appearance")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="p-0">
              <TerminalTabAppearancePicker
                color={row.tabColor}
                icon={row.tabIcon}
                onChange={(appearance) => onChangeAppearance(row.id, appearance)}
              />
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
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
              onSelect={() => onLocateInChat(row.agentSpawner!, row.agentSpawnerMessageId)}
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

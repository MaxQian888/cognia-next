"use client"

/**
 * Tab picker used by the chat surface when the user clicks "Run in dock"
 * on a Bash tool call. Lists the active project's tabs plus a
 * "New tab" option; calls back with the chosen target.
 *
 * Built on shadcn `Command` (cmdk) so keyboard navigation matches the
 * rest of the command-palette UI in the app.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, TerminalIcon } from "lucide-react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useProjectStore } from "@/stores/project/project-store"
import {
  displayTitle,
  useTerminalStore,
  type TerminalSessionRow,
} from "@/stores/terminal/terminal-store"

export interface TerminalTabPickerProps {
  /** Trigger element — usually a Button. */
  children: React.ReactNode
  /** Caller decides what to do with the resolved choice. */
  onPick: (choice: { kind: "existing"; row: TerminalSessionRow } | { kind: "new" }) => void
  /** Externally-controlled open state (optional). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function TerminalTabPicker({
  children,
  onPick,
  open: openProp,
  onOpenChange,
}: TerminalTabPickerProps) {
  const t = useTranslations("chat.terminalTool.runInDock")
  const [openInternal, setOpenInternal] = useState(false)
  const open = openProp ?? openInternal
  const setOpen = (next: boolean) => {
    setOpenInternal(next)
    onOpenChange?.(next)
  }

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Subscribe to the raw `sessions` record so the selector returns a stable
  // reference between renders. Memoize the filtered + sorted derivation so
  // the picker doesn't trip Zustand's reference-equality guard with a new
  // array each tick (infinite-loop trap).
  const sessions = useTerminalStore((s) => s.sessions)
  const tabs = useMemo(
    () =>
      Object.values(sessions)
        .filter((row) => (row.projectId ?? "") === (activeProjectId ?? ""))
        .sort((a, b) => a.createdAt - b.createdAt),
    [sessions, activeProjectId]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="terminal-tab-picker">
        <Command>
          <CommandInput placeholder={t("searchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("empty")}</CommandEmpty>
            {tabs.length > 0 ? (
              <CommandGroup heading={t("existingTabs")}>
                {tabs.map((row) => (
                  <CommandItem
                    key={row.id}
                    value={row.id}
                    onSelect={() => {
                      onPick({ kind: "existing", row })
                      setOpen(false)
                    }}
                    data-testid="terminal-tab-picker-existing"
                  >
                    <TerminalIcon className="mr-2 h-3.5 w-3.5" />
                    <span className="flex-1 truncate">{displayTitle(row)}</span>
                    {row.agentTrusted ? (
                      <span className="ml-2 text-[10px] text-amber-500">{t("trustedBadge")}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__new"
                onSelect={() => {
                  onPick({ kind: "new" })
                  setOpen(false)
                }}
                data-testid="terminal-tab-picker-new"
              >
                <PlusIcon className="mr-2 h-3.5 w-3.5" />
                {t("newTab")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default TerminalTabPicker

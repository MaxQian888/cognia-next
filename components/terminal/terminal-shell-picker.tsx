"use client"

/**
 * Split-button "+ New" affordance for the terminal dock.
 *
 * The primary button spawns a tab with the resolved default shell (project
 * override → settings → platform default — same as before). The attached
 * chevron opens a dropdown to launch a specific shell (PowerShell 7, Windows
 * PowerShell, cmd, bash, zsh) without a trip to settings.
 *
 * Presentational: owns no spawn logic. `onNew(shell?)` does the work — an
 * explicit `shell` skips `resolveDefaultShell`, `undefined` keeps the
 * default-resolution path. Mirrors how `TerminalTabStrip` slots controls.
 */

import { useTranslations } from "next-intl"
import { ChevronDownIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TerminalProfile } from "@/lib/terminal/profiles"

export interface TerminalShellPickerProps {
  /**
   * Spawn a new tab. `undefined` shell → resolve the project / settings /
   * platform default; a concrete value launches that shell directly.
   */
  onNew: (shell?: string) => void | Promise<void>
  /** Saved launch profiles to list above the built-in shells. */
  profiles?: TerminalProfile[]
  /** Spawn a tab from a saved profile id. */
  onNewProfile?: (profileId: string) => void | Promise<void>
}

/** Dropdown entries. `value: undefined` is the default-resolution path. */
const SHELL_OPTIONS: ReadonlyArray<{ value: string | undefined; labelKey: string }> = [
  { value: undefined, labelKey: "terminal.shellPicker.auto" },
  { value: "pwsh.exe", labelKey: "terminal.shellPicker.pwsh" },
  { value: "powershell.exe", labelKey: "terminal.shellPicker.powershell" },
  { value: "cmd.exe", labelKey: "terminal.shellPicker.cmd" },
  { value: "/bin/bash", labelKey: "terminal.shellPicker.bash" },
  { value: "/bin/zsh", labelKey: "terminal.shellPicker.zsh" },
]

export function TerminalShellPicker({ onNew, profiles, onNewProfile }: TerminalShellPickerProps) {
  const t = useTranslations()
  const namedProfiles = (profiles ?? []).filter((p) => p.shell.trim().length > 0)
  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void onNew()
        }}
        aria-label={t("terminal.dock.newSession")}
        data-testid="terminal-dock-new"
        className="h-7 rounded-r-none px-2 text-xs"
      >
        <PlusIcon className="mr-1 h-3 w-3" />
        {t("terminal.dock.newSession")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("terminal.shellPicker.label")}
            data-testid="terminal-dock-shell-picker"
            className="h-7 w-5 rounded-l-none border-l border-border/40 p-0"
          >
            <ChevronDownIcon className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {namedProfiles.length > 0 && onNewProfile ? (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("terminal.shellPicker.profilesLabel")}
              </DropdownMenuLabel>
              {namedProfiles.map((profile) => (
                <DropdownMenuItem
                  key={profile.id}
                  onSelect={() => {
                    void onNewProfile(profile.id)
                  }}
                  className="text-xs"
                  data-testid={`terminal-shell-picker-profile-${profile.id}`}
                >
                  {profile.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {SHELL_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.labelKey}
              onSelect={() => {
                void onNew(opt.value)
              }}
              className="text-xs"
            >
              {t(opt.labelKey as never)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default TerminalShellPicker

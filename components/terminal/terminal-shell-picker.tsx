"use client"

/**
 * Split-button "+ New" affordance for the terminal dock.
 *
 * The primary button spawns a tab with the resolved default shell (project
 * override → settings → platform default — same as before). The attached
 * chevron opens a dropdown to launch a specific shell without a trip to
 * settings.
 *
 * The built-in shell list is platform-aware: Windows shells (PowerShell 7,
 * Windows PowerShell, cmd) only on Windows, POSIX shells (zsh, bash, sh,
 * fish, nu) only on macOS/Linux — so a macOS user never sees PowerShell.
 * On desktop it then narrows to the shells actually installed on PATH
 * (via the `terminal_list_path_executables` scan); the "Default shell"
 * entry is always offered so the menu is never empty.
 *
 * Owns no spawn logic. `onNew(shell?)` does the work — an explicit `shell`
 * skips `resolveDefaultShell`, `undefined` keeps the default-resolution
 * path. Mirrors how `TerminalTabStrip` slots controls.
 */

import { useEffect, useMemo, useState } from "react"
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
import { isTauri } from "@/lib/tauri"
import type { TerminalProfile } from "@/lib/terminal/profiles"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import {
  detectPlatform,
  filterDetectedShellOptions,
  hostShellOptions,
  platformShellOptions,
  type ShellPlatform,
} from "@/lib/terminal/shell-detect"
import { useHostCapabilities } from "@/hooks/terminal/use-host-capabilities"

/** Probe PATH for which of `bins` resolve to a real executable. */
export type DetectShells = (bins: string[]) => Promise<ReadonlySet<string>>

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
  /**
   * Saved SSH hosts to offer alongside the local profiles. The caller is
   * responsible for withholding these off-desktop — SSH sessions are spawned
   * through Tauri commands and have no web or mobile path.
   */
  sshHosts?: readonly SshHostProfile[]
  /** Connect a tab to a saved SSH host. */
  onNewSshHost?: (hostId: string) => void | Promise<void>
  /** Override platform sniffing (tests). Defaults to `detectPlatform()`. */
  platform?: ShellPlatform
  /**
   * Probe PATH for installed shells. Injected for tests; defaults to the
   * Tauri `terminal_list_path_executables` scan on desktop and a no-op on
   * web (so the full platform list shows).
   */
  detectShells?: DetectShells
}

/**
 * Default detector: on desktop, ask the Rust PATH scan whether each shell
 * binary resolves; on web, return an empty set (no detection → show the
 * full platform list). Matches case-insensitively and ignores a trailing
 * `.exe` so `cmd.exe` satisfies the `cmd` probe on Windows.
 *
 * Not used at all against a remote host: the scan is a Tauri command, so it
 * would describe the wrong machine. The host reports its own shells instead —
 * see `hostShellOptions`.
 */
const defaultDetectShells: DetectShells = async (bins) => {
  if (!isTauri() || bins.length === 0) return new Set()
  const { invoke } = await import("@tauri-apps/api/core")
  const stem = (n: string) => n.toLowerCase().replace(/\.exe$/, "")
  const found = new Set<string>()
  await Promise.all(
    bins.map(async (bin) => {
      try {
        const res = await invoke("terminal_list_path_executables", { prefix: bin, limit: 8 })
        const names = Array.isArray(res) ? (res as string[]) : []
        if (names.some((n) => stem(n) === bin.toLowerCase())) found.add(bin.toLowerCase())
      } catch {
        /* scan unavailable — leave this bin undetected */
      }
    })
  )
  return found
}

export function TerminalShellPicker({
  onNew,
  profiles,
  onNewProfile,
  sshHosts,
  onNewSshHost,
  platform,
  detectShells = defaultDetectShells,
}: TerminalShellPickerProps) {
  const t = useTranslations()
  const namedProfiles = (profiles ?? []).filter((p) => p.shell.trim().length > 0)
  // A half-filled host row is a draft in the settings editor, not something
  // worth offering here — connecting would only produce a validation error.
  const namedSshHosts = (sshHosts ?? []).filter(
    (h) => h.name.trim().length > 0 && h.host.trim().length > 0 && h.username.trim().length > 0
  )

  // `null` on the local PTY (and before a remote host has answered), which is
  // exactly when the platform sniff below is the right story.
  const host = useHostCapabilities()
  const baseOptions = useMemo(
    () =>
      host
        ? hostShellOptions(host.availableShells)
        : platformShellOptions(platform ?? detectPlatform()),
    [host, platform]
  )
  // Empty until the PATH scan resolves → the full platform list shows first,
  // then narrows to installed shells. `filterDetectedShellOptions` keeps the
  // full list when detection is empty or would hide everything.
  const [detectedBins, setDetectedBins] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (host) return
    let alive = true
    void detectShells(baseOptions.map((o) => o.bin))
      .then((set) => {
        // Empty result ⇒ detection unavailable (web) or nothing found; that
        // already maps to the full platform list (the initial state), so
        // skip the state update — avoids a needless re-render.
        if (alive && set.size > 0) setDetectedBins(set)
      })
      .catch(() => {
        /* keep the unfiltered list */
      })
    return () => {
      alive = false
    }
  }, [baseOptions, detectShells, host])

  // The host already filtered to shells that exist on it, so there is nothing
  // left for the PATH scan to narrow — and nothing it *could* narrow, since it
  // probes this machine.
  const shellOptions = host ? baseOptions : filterDetectedShellOptions(baseOptions, detectedBins)
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
          {namedSshHosts.length > 0 && onNewSshHost ? (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("terminal.shellPicker.sshLabel")}
              </DropdownMenuLabel>
              {namedSshHosts.map((host) => (
                <DropdownMenuItem
                  key={host.id}
                  onSelect={() => {
                    void onNewSshHost(host.id)
                  }}
                  className="text-xs"
                  data-testid={`terminal-shell-picker-ssh-${host.id}`}
                >
                  {host.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {/* Always-offered default-resolution path (project → settings → platform). */}
          <DropdownMenuItem
            onSelect={() => {
              void onNew(undefined)
            }}
            className="text-xs"
          >
            {t("terminal.shellPicker.auto")}
          </DropdownMenuItem>
          {shellOptions.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              onSelect={() => {
                void onNew(opt.value)
              }}
              className="text-xs"
              data-testid={`terminal-shell-picker-shell-${opt.bin}`}
            >
              {/* A host can report a shell with no translated name (a custom
                  build, a Nix store path); showing its path beats hiding it. */}
              {opt.labelKey ? t(opt.labelKey as never) : opt.value}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default TerminalShellPicker

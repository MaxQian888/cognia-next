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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BAUD_RATES } from "@/lib/terminal/serial"
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

/**
 * What a serial row opens at when the user clicks it rather than reaching for
 * the baud submenu. 115200 is what most USB-serial adapters and modern
 * bootloaders ship at, so it is the one-click case.
 */
const DEFAULT_SERIAL_BAUD = 115200

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
   * Saved SSH hosts to offer alongside the local profiles.
   *
   * Offered on every shell. A desktop builds the request itself and hands it to
   * `ssh_terminal_spawn`; anywhere else the host resolves the profile id
   * against its own `ssh_profiles` map and dials with credentials that never
   * leave it. What a paired device does NOT get is a jump chain or a port
   * forward, which `buildSynchronizedSshProfiles` strips by design.
   */
  sshHosts?: readonly SshHostProfile[]
  /** Connect a tab to a saved SSH host. */
  onNewSshHost?: (hostId: string) => void | Promise<void>
  /**
   * Open a serial port as a tab. Omitted on every shell that is not holding
   * the hardware: a port is a device node on this machine, and
   * `terminal_open_serial` is `target: "client"` for exactly that reason.
   */
  onNewSerialPort?: (path: string, baudRate: number) => void | Promise<void>
  /**
   * Attach to a running tmux session. The session list comes from the tmux
   * server, so it is the HOST's sessions, and attaching spawns a normal shell
   * that runs the attach command.
   */
  onAttachTmuxSession?: (sessionName: string) => void | Promise<void>
  /** Test seam for the serial port scan. */
  listSerialPorts?: () => Promise<readonly { path: string; product: string | null }[]>
  /** Test seam for the tmux session scan. */
  listTmuxSessions?: () => Promise<readonly { name: string; windowCount: number }[]>
  /**
   * How big the affordance is drawn.
   *
   * `dock` is the compact "+ New" with its label and an attached chevron.
   * `touch` is the same split affordance sized for a finger, with the label
   * dropped, for a mobile header where a 28px control with 12px text has no
   * place.
   *
   * Both are splits, deliberately. Collapsing the touch variant into a single
   * menu button would cost the phone its one-tap "new terminal", which is the
   * primary action on that screen, in exchange for a list it usually does not
   * need. The menu behind the chevron is identical in both, which is the
   * point: "what can I launch from here" is one answer, not one per shell.
   */
  variant?: "dock" | "touch"
  /** Test id for the menu trigger, so a host screen keeps a stable anchor. */
  triggerTestId?: string
  /** Test id for the primary new-session button, same reason. */
  newTestId?: string
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

/**
 * The two device scans, behind the same shape as `defaultDetectShells`: they
 * resolve to an empty list on any failure, so a host without tmux or without a
 * serial adapter simply shows no section rather than an error row.
 *
 * They differ in reach. tmux rides the routed transport and so describes
 * whichever host the app is driving; serial is a `transports: ["internal"]`
 * command and really does only describe this machine.
 */
async function defaultListSerialPorts() {
  if (!isTauri()) return []
  const { listSerialPorts } = await import("@/lib/terminal/serial")
  return (await listSerialPorts()).map((port) => ({
    path: port.path,
    product: port.product ?? port.manufacturer,
  }))
}

async function defaultListTmuxSessions() {
  // No `isTauri()` guard: the three `terminal_list_tmux_*` commands are
  // remote-reachable, and `listTmuxSessions` already answers [] for a host that
  // has no tmux and for a standalone browser whose transport rejects. Guarding
  // here made a browser paired to a Host report "no tmux" for a machine with it.
  const { listTmuxSessions } = await import("@/lib/terminal/multiplexer")
  return (await listTmuxSessions()).map((session) => ({
    name: session.name,
    windowCount: session.windowCount,
  }))
}

export function TerminalShellPicker({
  onNew,
  profiles,
  onNewProfile,
  sshHosts,
  onNewSshHost,
  onNewSerialPort,
  onAttachTmuxSession,
  listSerialPorts = defaultListSerialPorts,
  listTmuxSessions = defaultListTmuxSessions,
  variant = "dock",
  triggerTestId,
  newTestId,
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

  // Device scans. Run once when the picker mounts rather than on every menu
  // open: enumerating serial ports walks the OS device tree and listing tmux
  // sessions is a socket round-trip, and neither answer changes often enough
  // to pay that on each click. A device plugged in after mount appears on the
  // next dock mount, which is the same freshness the shell scan has.
  const [serialPorts, setSerialPorts] = useState<
    readonly { path: string; product: string | null }[]
  >([])
  const [tmuxSessions, setTmuxSessions] = useState<
    readonly { name: string; windowCount: number }[]
  >([])
  useEffect(() => {
    if (!onNewSerialPort) return
    let alive = true
    void listSerialPorts()
      .then((ports) => {
        if (alive) setSerialPorts(ports)
      })
      .catch(() => {
        /* no adapter, or no permission to enumerate — show no section */
      })
    return () => {
      alive = false
    }
  }, [listSerialPorts, onNewSerialPort])
  useEffect(() => {
    if (!onAttachTmuxSession) return
    let alive = true
    void listTmuxSessions()
      .then((sessions) => {
        if (alive) setTmuxSessions(sessions)
      })
      .catch(() => {
        /* tmux not installed, or no server running — show no section */
      })
    return () => {
      alive = false
    }
  }, [listTmuxSessions, onAttachTmuxSession])

  // The host already filtered to shells that exist on it, so there is nothing
  // left for the PATH scan to narrow — and nothing it *could* narrow, since it
  // probes this machine.
  const shellOptions = host ? baseOptions : filterDetectedShellOptions(baseOptions, detectedBins)
  const touch = variant === "touch"
  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void onNew()
        }}
        aria-label={t("terminal.dock.newSession")}
        data-testid={newTestId ?? "terminal-dock-new"}
        className={touch ? "h-8 w-8 rounded-r-none p-0" : "h-7 rounded-r-none px-2 text-xs"}
      >
        <PlusIcon className={touch ? "h-4 w-4" : "mr-1 h-3 w-3"} />
        {touch ? null : t("terminal.dock.newSession")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("terminal.shellPicker.label")}
            data-testid={triggerTestId ?? "terminal-dock-shell-picker"}
            className={
              touch
                ? "h-8 w-6 rounded-l-none border-l border-border/40 p-0"
                : "h-7 w-5 rounded-l-none border-l border-border/40 p-0"
            }
          >
            <ChevronDownIcon className={touch ? "h-3.5 w-3.5" : "h-3 w-3"} />
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
          {tmuxSessions.length > 0 && onAttachTmuxSession ? (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("terminal.shellPicker.tmuxLabel")}
              </DropdownMenuLabel>
              {tmuxSessions.map((session) => (
                <DropdownMenuItem
                  key={session.name}
                  onSelect={() => {
                    void onAttachTmuxSession(session.name)
                  }}
                  className="text-xs"
                  data-testid={`terminal-shell-picker-tmux-${session.name}`}
                >
                  {t("terminal.shellPicker.tmuxSession", {
                    name: session.name,
                    count: session.windowCount,
                  })}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {serialPorts.length > 0 && onNewSerialPort ? (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("terminal.shellPicker.serialLabel")}
              </DropdownMenuLabel>
              {serialPorts.map((port) => (
                /* Baud is a submenu rather than a fixed default because a
                   device at the wrong rate produces not an error but garbage,
                   which reads as a broken adapter. The row itself opens at
                   115200, the modern default and the one most USB adapters
                   ship at, so the common case is still one click. */
                <DropdownMenuSub key={port.path}>
                  <DropdownMenuSubTrigger
                    className="text-xs"
                    data-testid={`terminal-shell-picker-serial-${port.path}`}
                    onClick={() => {
                      void onNewSerialPort(port.path, DEFAULT_SERIAL_BAUD)
                    }}
                  >
                    {/* The product name is what a user recognises ("CH340");
                        the path is what identifies the device. Both, because a
                        machine with two identical adapters has two identical
                        product names. */}
                    {port.product ? `${port.product} — ${port.path}` : port.path}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {BAUD_RATES.map((baud) => (
                      <DropdownMenuItem
                        key={baud}
                        className="text-xs"
                        onSelect={() => {
                          void onNewSerialPort(port.path, baud)
                        }}
                        data-testid={`terminal-shell-picker-serial-${port.path}-${baud}`}
                      >
                        {t("terminal.shellPicker.serialBaud", { baud })}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
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

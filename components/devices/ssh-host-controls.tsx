"use client"

/**
 * A saved SSH host, as the fleet console can honestly present it.
 *
 * The repo has a complete russh client (TOFU `known_hosts`, jump chains,
 * bidirectional port forwarding, `~/.ssh/config` import) and it lived in one
 * form under Settings → Terminal. It was the one class of remote machine no
 * machine directory listed, which is backwards: Tailscale, Termius and VS
 * Code's Remote Explorer all put SSH targets in the same list as everything
 * else.
 *
 * Two things this deliberately does not do:
 *
 *  * **It does not edit.** Ports, keys, jump chains and forwarding rules stay
 *    in the Settings editor. A fleet view that grew a second, smaller form for
 *    the same profile would be two places to change a port.
 *  * **It does not pretend a phone can connect.** `ssh_terminal_*` is
 *    `target: "client"` with `capability: client.local`, and
 *    `TerminalHost::spawn_local` refuses a non-local identity, so a paired
 *    device or a browser genuinely cannot open one. The button renders,
 *    disabled, with the reason. Hiding it would merge "not supported here"
 *    with "you have no SSH hosts".
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { KeyRoundIcon, PlugZapIcon, SettingsIcon, TerminalIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { DeviceRow } from "@/lib/devices/types"
import { connectSshFromDock, resolveSshHostLaunch } from "@/lib/terminal/ssh-connect"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { isTauri } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

/** Default geometry for a session opened from a console row rather than a pane. */
const DEFAULT_ROWS = 24
const DEFAULT_COLS = 80

export interface SshHostControlsProps {
  row: DeviceRow
  /** Test seam. Defaults to the real dock launcher. */
  connect?: typeof connectSshFromDock
}

export function SshHostControls({ row, connect = connectSshFromDock }: SshHostControlsProps) {
  const t = useTranslations("devices.ssh")
  const terminal = useSettingsStore((s) => s.settings.terminalSettings)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const profileId = row.ref.startsWith("ssh:") ? row.ref.slice(4) : null
  // Memoised so `onConnect`'s identity is stable: a jump host is stored as a
  // profile id, so the whole set has to travel with the one being launched or
  // a bastion-backed host connects direct.
  const hosts = useMemo(() => (terminal?.sshHosts ?? []) as SshHostProfile[], [terminal?.sshHosts])
  const launch = useMemo(
    () => (profileId ? resolveSshHostLaunch(profileId, hosts) : { kind: "unknownHost" as const }),
    [profileId, hosts]
  )
  const local = isTauri()

  const onConnect = useCallback(async () => {
    if (launch.kind !== "ready") return
    setError(null)
    setBusy(true)
    try {
      const outcome = await connect({
        profile: launch.profile,
        allProfiles: hosts,
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        // Read at call time, like the dock does: subscribing the whole store
        // here would re-render this card on every keystroke in any terminal.
        store: useTerminalStore.getState(),
      })
      if (outcome.kind === "error") setError(outcome.message)
    } finally {
      setBusy(false)
    }
  }, [connect, hosts, launch])

  if (row.kind !== "ssh-host") return null

  return (
    <div className="space-y-3" data-testid="ssh-host-controls">
      {/*
        Stated once, at the top, because it governs every control below. A
        reader who does not know SSH is local-identity only will read a
        disabled button as a bug.
      */}
      {!local ? (
        <Alert data-testid="ssh-local-only">
          <AlertTitle>{t("localOnlyTitle")}</AlertTitle>
          <AlertDescription>{t("localOnlyBody")}</AlertDescription>
        </Alert>
      ) : null}

      {launch.kind === "credentialRequired" ? (
        <Alert data-testid="ssh-credential-required">
          <AlertTitle>{t("credentialRequiredTitle")}</AlertTitle>
          <AlertDescription>{t("credentialRequiredBody", { name: launch.name })}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void onConnect()}
          disabled={!local || launch.kind !== "ready" || busy}
          data-testid="ssh-connect"
        >
          {launch.kind === "credentialRequired" ? (
            <KeyRoundIcon className="size-3.5" />
          ) : (
            <PlugZapIcon className="size-3.5" />
          )}
          {busy ? t("connecting") : t("connect")}
        </Button>
        <Button asChild size="sm" variant="ghost" data-testid="ssh-edit">
          <Link href="/settings?section=terminal">
            <SettingsIcon className="size-3.5" />
            {t("edit")}
          </Link>
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="ssh-connect-error">
          {error}
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <TerminalIcon className="size-3" aria-hidden />
        {t("shellOnly")}
      </p>
    </div>
  )
}

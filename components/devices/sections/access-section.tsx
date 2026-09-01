"use client"

/**
 * What this device is allowed to do here, and what that actually confers.
 *
 * The behaviour is carried over from `paired-devices-card.tsx` unchanged —
 * same writes, same biometric gating, same `data-testid`s — with one thing
 * added that the card could not express: each grant is shown **expanded into
 * the SecurityStore capabilities it maps onto**, with a `partial` state.
 *
 * That mattered because `companion_list_device_grants` answers each grant with
 * an all-of test. A device holding `agent.run` but not `workspace.write` came
 * back `false` and rendered exactly like a device that had never been granted
 * anything, so a half-revoked grant was indistinguishable from no grant.
 */

import { useTranslations } from "next-intl"
import { KeyRoundIcon, PauseIcon, PlayIcon, TrashIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { isGrantEnabled } from "@/lib/devices/grant-capabilities"
import type { DeviceGrantRow, DeviceRow } from "@/lib/devices/types"
import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import { GrantStateBadge } from "../device-visuals"

/** The `data-testid` the card used, kept so its coverage ports across. */
const TEST_IDS: Record<DeviceGrantRow["id"], string> = {
  control: "paired-device-remote-control",
  agentControl: "paired-device-agent-control",
  terminal: "paired-device-remote-terminal",
  sshFiles: "paired-device-ssh-files",
  lockedComputerUse: "paired-device-locked-computer-use",
}

function GrantSection({
  row,
  grant,
  actions,
}: {
  row: DeviceRow
  grant: DeviceGrantRow
  actions: DeviceGrantActions
}) {
  const t = useTranslations("devices")
  const tRc = useTranslations("mobile.companion.remoteControl")
  const tAc = useTranslations("mobile.companion.agentControl")
  const tTerminal = useTranslations("mobile.companion.remoteTerminal")
  const tSshFiles = useTranslations("mobile.companion.sshFiles")
  const tLocked = useTranslations("mobile.companion.lockedComputerUse")

  const namespace =
    grant.id === "control"
      ? tRc
      : grant.id === "agentControl"
        ? tAc
        : grant.id === "terminal"
          ? tTerminal
          : grant.id === "sshFiles"
            ? tSshFiles
            : tLocked

  const deviceId = row.deviceId ?? ""
  const revoked = row.adminState === "revoked"

  /**
   * The terminal grant is the one row that is written from a machine rather
   * than from an account.
   *
   * `useDeviceGrantActions.hostCall` is a no-op off Tauri, so flipping this
   * anywhere else would write the Dexie mirror and leave the host's own answer
   * untouched, which is a switch that reports a grant nobody made. It used to
   * be `!isTauri()` and a dead switch with no sentence beside it, which is the
   * shape that collapses "never existed here", "one pairing away" and "broken
   * right now" into one silence. `requirement: "desktop-shell"` is the honest
   * question: a headless host runs plenty of capabilities and cannot write
   * this one.
   */
  const terminalReach = useSurfaceReach({ capability: "pty", requirement: "desktop-shell" })

  /**
   * ...and so is every other grant on this card.
   *
   * All four switches write through `companion_set_*`, which the manifest files
   * as `target: "client"` with `transports: ["internal"]`: the desktop renderer
   * writes them over Tauri IPC and nothing else can. The terminal row was
   * gated and the other three were not, so on a phone or a browser tab they
   * looked live, flipped, and reported a grant the host never heard about.
   *
   * `capability: "webview"` is the formality here — `requirement:
   * "desktop-shell"` short-circuits ahead of the capability check in
   * `resolveSurfaceReach`, and being the desktop process is the whole
   * requirement.
   */
  const shellReach = useSurfaceReach({ capability: "webview", requirement: "desktop-shell" })
  // Same machine-not-account question as the terminal row: this grant reaches
  // SSH profiles the host resolves from its own keyring, so a host with no
  // shell to run them has nothing to grant.
  const terminalBlocked =
    (grant.id === "terminal" || grant.id === "sshFiles") && !terminalReach.available
  const shellBlocked = !shellReach.available

  /**
   * Locked Use is meaningful only together with remote control — the native
   * lease validator requires both — so it cannot be armed on its own.
   */
  const controlHeld = isGrantEnabled(
    row.grants.find((candidate) => candidate.id === "control") ?? grant
  )

  const disabled =
    revoked ||
    !grant.available ||
    terminalBlocked ||
    shellBlocked ||
    (grant.id === "lockedComputerUse" && !controlHeld)

  const onChange = (next: boolean) => {
    if (grant.id === "control") return void actions.toggleRemoteControl(deviceId, row.label, next)
    if (grant.id === "agentControl")
      return void actions.toggleAgentControl(deviceId, row.label, next)
    if (grant.id === "terminal") {
      return void actions.toggleRemoteTerminal(deviceId, row.pubkey ?? "", row.label, next)
    }
    if (grant.id === "sshFiles") return void actions.toggleSshFiles(deviceId, row.label, next)
    return void actions.toggleLockedComputerUse(deviceId, row.label, next)
  }

  return (
    <section className="rounded-lg border bg-background/40 p-3" data-testid={`grant-${grant.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{namespace("col")}</span>
            <GrantStateBadge state={grant.state} />
            {/* Inert while `LOCKED_USE_AVAILABLE` is false — see its docs. */}
            {!grant.available ? (
              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                {tLocked("unavailable")}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{namespace("description")}</p>
          {/*
            A grant whose blast radius grew has to say so where it is toggled,
            not only where it is used. `terminal.open` now also lets the device
            open any SSH host this machine has saved, because
            `spawn_synchronized_profile` resolves them out of the host's own
            keyring, and the `ssh_profiles` map is shared rather than scoped per
            device the way local PTY profiles are.
          */}
          {grant.id === "terminal" ? (
            <p className="text-[11px] text-muted-foreground" data-testid="grant-terminal-ssh-note">
              {t("access.terminalReachesSsh")}
            </p>
          ) : null}
          {/*
            ADR-0162 refuses to claim a confinement it cannot enforce, and the
            place that has to say so is the switch. An SFTP path is the remote
            machine's absolute path and that machine resolves its own symlinks,
            so there is no root to confine this to. Saying it here is one of the
            three places the record commits to.
          */}
          {grant.id === "sshFiles" ? (
            <p className="text-[11px] text-muted-foreground" data-testid="grant-ssh-files-note">
              {t("access.sshFilesReachIsWhole")}
            </p>
          ) : null}
        </div>
        <Switch
          checked={grant.available && isGrantEnabled(grant)}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={namespace("toggleAria", { label: row.label })}
          data-testid={`${TEST_IDS[grant.id]}-${deviceId}`}
        />
      </div>

      {grant.capabilities.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1" data-testid={`grant-capabilities-${grant.id}`}>
          {grant.capabilities.map((capability) => {
            const held = grant.heldCapabilities.includes(capability)
            return (
              <li key={capability}>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[10px] font-normal",
                    held
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground line-through decoration-muted-foreground/40"
                  )}
                >
                  {capability}
                </Badge>
              </li>
            )
          })}
        </ul>
      ) : null}

      {terminalBlocked ? (
        <SurfaceUnavailableNotice
          reach={terminalReach}
          className="mt-2"
          data-testid={`grant-${grant.id}-unavailable`}
        />
      ) : null}

      {grant.state === "partial" ? (
        <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          {t("access.partialHint")}
        </p>
      ) : null}
      {grant.reasonKey ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t(`access.reason.${grant.reasonKey}`)}
        </p>
      ) : null}
    </section>
  )
}

export function AccessSection({ row, actions }: { row: DeviceRow; actions: DeviceGrantActions }) {
  const t = useTranslations("devices")
  /**
   * Pause, resume and revoke are `companion_suspend_device`,
   * `companion_resume_device` and `companion_revoke_device`, the same
   * `target: "client"` / `transports: ["internal"]` shape as the four grant
   * switches, so they too are writable only from the desktop process. One
   * notice for the whole section rather than one per control: the fact is
   * about this shell, not about any single button, which is how
   * `ownerSuspended` below already reads.
   *
   * Above the early return, because a hook cannot be called conditionally.
   */
  const shellReach = useSurfaceReach({ capability: "webview", requirement: "desktop-shell" })
  const shellBlocked = !shellReach.available

  if (row.kind !== "paired-device") {
    return (
      <DeviceSection id="access" title={t("access.title")} icon={KeyRoundIcon} wide>
        <Alert data-testid="device-access">
          <AlertTitle>{t("access.notApplicableTitle")}</AlertTitle>
          <AlertDescription>{t(`access.notApplicable.${row.kind}`)}</AlertDescription>
        </Alert>
      </DeviceSection>
    )
  }

  const deviceId = row.deviceId ?? ""
  const revoked = row.adminState === "revoked"
  const paused = row.adminState === "paused"

  const held = row.grants.filter((grant) => grant.available && isGrantEnabled(grant)).length
  // ADR-0149 §5 step two. One banner rather than four identical reason lines:
  // the fact is about the device, not about any one grant.
  const ownerSuspended = row.grants.some((grant) => grant.state === "suspended")

  return (
    <DeviceSection
      id="access"
      title={t("access.title")}
      icon={KeyRoundIcon}
      wide
      meta={t("access.heldCount", {
        held,
        total: row.grants.filter((grant) => grant.available).length,
      })}
    >
      <div className="space-y-3" data-testid="device-access">
        {revoked ? (
          <Alert variant="destructive">
            <AlertTitle>{t("access.revokedTitle")}</AlertTitle>
            <AlertDescription>{t("access.revokedBody")}</AlertDescription>
          </Alert>
        ) : null}

        {ownerSuspended ? (
          <Alert data-testid="device-access-owner-suspended">
            <AlertTitle>{t("access.ownerSuspendedHint")}</AlertTitle>
            <AlertDescription>{t("access.reason.ownerMismatch")}</AlertDescription>
          </Alert>
        ) : null}

        {shellBlocked ? (
          <SurfaceUnavailableNotice
            reach={shellReach}
            data-testid="device-access-shell-unavailable"
          />
        ) : null}

        {/* Two grants abreast once the pane can seat them: each is a short
            title, a sentence and a switch, so a single column at full pane
            width is mostly empty space to the right of every switch. */}
        <div className="grid gap-3 @2xl/device-card:grid-cols-2">
          {row.grants.map((grant) => (
            <GrantSection key={grant.id} row={row} grant={grant} actions={actions} />
          ))}
        </div>

        <section className="rounded-lg border bg-background/40 p-3">
          <h4 className="text-sm font-medium">{t("access.lifecycle")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t("access.lifecycleHint")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {!revoked && !paused ? (
              <Button
                size="sm"
                variant="outline"
                disabled={shellBlocked}
                onClick={() => void actions.pause(deviceId, row.label)}
                data-testid={`paired-device-pause-${deviceId}`}
              >
                <PauseIcon className="size-3.5" />
                {t("access.pause")}
              </Button>
            ) : null}
            {!revoked && paused ? (
              <Button
                size="sm"
                variant="outline"
                disabled={shellBlocked}
                onClick={() => void actions.resume(deviceId, row.label)}
                data-testid={`paired-device-resume-${deviceId}`}
              >
                <PlayIcon className="size-3.5" />
                {t("access.resume")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="destructive"
              disabled={revoked || shellBlocked}
              onClick={() => void actions.revoke(deviceId, row.label)}
              data-testid={`paired-device-revoke-${deviceId}`}
            >
              <TrashIcon className="size-3.5" />
              {t("access.revoke")}
            </Button>
          </div>
        </section>
      </div>
    </DeviceSection>
  )
}

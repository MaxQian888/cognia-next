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
import { isTauri } from "@/lib/tauri"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import { GrantStateBadge } from "../device-visuals"

/** The `data-testid` the card used, kept so its coverage ports across. */
const TEST_IDS: Record<DeviceGrantRow["id"], string> = {
  control: "paired-device-remote-control",
  agentControl: "paired-device-agent-control",
  terminal: "paired-device-remote-terminal",
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
  const tLocked = useTranslations("mobile.companion.lockedComputerUse")

  const namespace =
    grant.id === "control"
      ? tRc
      : grant.id === "agentControl"
        ? tAc
        : grant.id === "terminal"
          ? tTerminal
          : tLocked

  const deviceId = row.deviceId ?? ""
  const revoked = row.adminState === "revoked"

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
    (grant.id === "terminal" && !isTauri()) ||
    (grant.id === "lockedComputerUse" && !controlHeld)

  const onChange = (next: boolean) => {
    if (grant.id === "control") return void actions.toggleRemoteControl(deviceId, row.label, next)
    if (grant.id === "agentControl")
      return void actions.toggleAgentControl(deviceId, row.label, next)
    if (grant.id === "terminal") {
      return void actions.toggleRemoteTerminal(deviceId, row.pubkey ?? "", row.label, next)
    }
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
              disabled={revoked}
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

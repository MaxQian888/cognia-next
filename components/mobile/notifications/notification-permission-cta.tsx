"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon, SettingsIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import {
  checkPermission,
  requestPermission,
  type PermissionState,
} from "@/lib/capacitor/local-notifications"

/**
 * Card-style CTA that asks the user to grant local-notification
 * permission. Mounted at the end of the pair flow (`paired-step.tsx`)
 * so the prompt arrives at a moment the user has obvious intent —
 * never on first launch.
 *
 * Three rendered phases:
 *
 *   1. **prompt** — user hasn't decided; show the "Enable" CTA.
 *   2. **denied** — user previously denied; show "Open Settings".
 *      On iOS there is no programmatic re-prompt once the user has
 *      tapped Don't Allow, so the only recovery is the system settings
 *      deep link.
 *   3. **granted** / unsupported — component renders nothing.
 *
 * Test seam: `checker` and `requester` default to the real wrappers but
 * can be injected for unit tests.
 */

type Checker = typeof checkPermission
type Requester = typeof requestPermission
type SettingsOpener = typeof openAppSettings

export interface NotificationPermissionCtaProps {
  /** Test seams. */
  checker?: Checker
  requester?: Requester
  settingsOpener?: SettingsOpener
  /** Override the testid root for nested usage. */
  testid?: string
}

type Phase = { kind: "hidden" } | { kind: "prompt"; requesting: boolean } | { kind: "denied" }

export function NotificationPermissionCta({
  checker = checkPermission,
  requester = requestPermission,
  settingsOpener = openAppSettings,
  testid = "notification-permission-cta",
}: NotificationPermissionCtaProps) {
  const t = useTranslations("mobile.notifications.permissionCta")
  const [phase, setPhase] = useState<Phase>({ kind: "hidden" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const out = await checker()
      if (cancelled) return
      setPhase(phaseFromPermission(out))
    })()
    return () => {
      cancelled = true
    }
  }, [checker])

  const onEnable = useCallback(async () => {
    setPhase({ kind: "prompt", requesting: true })
    const out = await requester()
    setPhase(phaseFromPermission(out))
  }, [requester])

  const onOpenSettings = useCallback(async () => {
    await settingsOpener()
  }, [settingsOpener])

  if (phase.kind === "hidden") return null

  return (
    <Alert
      className="border-amber-500/40 bg-amber-500/5"
      data-testid={testid}
      data-phase={phase.kind}
    >
      <BellIcon className="text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-700 dark:text-amber-300">{t("title")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{phase.kind === "denied" ? t("descriptionDenied") : t("description")}</span>
        {phase.kind === "prompt" ? (
          <Button
            type="button"
            size="sm"
            className="self-start touch-target"
            disabled={phase.requesting}
            onClick={() => void onEnable()}
            data-testid={`${testid}-enable`}
          >
            <BellIcon className="size-4" aria-hidden="true" />
            {phase.requesting ? t("enableInProgress") : t("enableButton")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start touch-target"
            onClick={() => void onOpenSettings()}
            data-testid={`${testid}-settings`}
          >
            <SettingsIcon className="size-4" aria-hidden="true" />
            {t("settingsButton")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function phaseFromPermission(outcome: Awaited<ReturnType<Checker>>): Phase {
  if (outcome.kind === "unsupported") return { kind: "hidden" }
  if (outcome.kind === "error") return { kind: "hidden" }
  const value: PermissionState = outcome.value
  if (value === "granted") return { kind: "hidden" }
  if (value === "denied") return { kind: "denied" }
  return { kind: "prompt", requesting: false }
}

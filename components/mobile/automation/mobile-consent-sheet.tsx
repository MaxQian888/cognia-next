"use client"

/**
 * Mobile computer-use consent sheet.
 *
 * The host renders a desktop `<ConsentOverlay>` for local Per-Call consent;
 * this is the phone-side equivalent for a paired device with the remote-control
 * capability. When the desktop's automation gate needs HITL consent, the
 * `automation:consent-request` frame streams over `/ws/v1/events`; this sheet
 * surfaces it and resolves it via `automation_consent_respond` (first-responder
 * wins — the desktop overlay and any attached phone race harmlessly).
 *
 * - Renders nothing unless this device holds the control capability
 *   (`useCanControl`), so observe-only devices never see an un-actionable
 *   prompt.
 * - Allowing lets the host execute a click / type / etc., so it is gated behind
 *   the biometric guard (mirrors `remote-sessions/approval-card.tsx`); rejecting
 *   applies immediately. Dismissing the sheet rejects the current prompt.
 *
 * Mounted once from `MobileShellWrapper` (mobile branch only).
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ShieldAlertIcon } from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useCanControl } from "@/hooks/data/use-can-control"
import {
  useAutomationConsent,
  type PendingConsent,
} from "@/hooks/automation/use-automation-consent"

export function MobileConsentSheet() {
  const t = useTranslations("automation.consent")
  const tm = useTranslations("mobile.automation.consent")
  const guard = useBiometricGuard()
  const canControl = useCanControl()
  const { queue, now, respond } = useAutomationConsent({ enabled: canControl === true })

  const current: PendingConsent | undefined = queue[0]

  const onAllow = useCallback(
    async (event: PendingConsent, persist: boolean) => {
      const result = await guard(
        {
          reason: tm("biometricReason"),
          title: tm("biometricTitle"),
          description: tm("biometricDescription"),
        },
        async () => {
          await respond(event, true, persist)
        }
      )
      if (result.kind === "blocked" && result.reason !== "cancelled") {
        toast.error(tm("biometricBlocked", { reason: result.reason }))
      }
    },
    [guard, respond, tm]
  )

  if (canControl !== true || !current) return null

  const remaining = queue.length - 1
  const secondsLeft = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))

  // Translate the verb / surface tags. Unknown verbs fall through to the raw
  // command so an unrecognized future action still renders something usable.
  const commandLabel = t.has(`commands.${current.command}`)
    ? t(`commands.${current.command}` as Parameters<typeof t>[0])
    : current.command
  const surfaceLabel = t(`surfaces.${current.surface}` as Parameters<typeof t>[0])

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        // Swipe-down / overlay tap / Esc = reject the current prompt.
        if (!open) void respond(current, false, false)
      }}
    >
      <SheetContent side="bottom" className="gap-0" data-testid="mobile-consent-sheet">
        <SheetHeader className="px-1">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShieldAlertIcon className="size-4 text-amber-500" aria-hidden="true" />
            {t("title")}
          </SheetTitle>
          <SheetDescription className="text-xs">{tm("sheetDescription")}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-1 py-3">
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("fields.action")}</span>
              <span className="font-medium">{commandLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("fields.surface")}</span>
              <Badge variant="secondary" className="text-[10px]">
                {surfaceLabel}
              </Badge>
            </div>
            {current.pluginId && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("fields.plugin")}</span>
                <code className="font-mono text-[11px]">{current.pluginId}</code>
              </div>
            )}
            {current.windowTitle && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("fields.window")}</span>
                <span className="truncate text-[11px]">{current.windowTitle}</span>
              </div>
            )}
            {current.processName && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("fields.process")}</span>
                <code className="font-mono text-[11px]">{current.processName}</code>
              </div>
            )}
            <div className="pt-1 text-[10px] text-muted-foreground">
              {t("fields.autoReject", { seconds: secondsLeft })}
              {remaining > 0 && (
                <span className="ml-2">{t("fields.morePending", { count: remaining })}</span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              onClick={() => void onAllow(current, false)}
              data-testid="mobile-consent-allow"
            >
              {t("actions.allowOnce")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void onAllow(current, true)}
              data-testid="mobile-consent-allow-always"
            >
              {t("actions.allowSession")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void respond(current, false, false)}
              data-testid="mobile-consent-reject"
            >
              {t("actions.reject")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

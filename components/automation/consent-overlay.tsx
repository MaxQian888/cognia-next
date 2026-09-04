"use client"

/**
 * Floating consent overlay for the automation `PerCall` tier.
 *
 * The prompt stream itself (subscribe, dedupe by broker id, countdown tick,
 * expiry sweep, respond) belongs to `useAutomationConsent`, shared with the
 * mobile `<MobileConsentSheet>`. This file is the desktop presentation only.
 *
 * Each `automation:consent-request` payload, emitted by the Rust-side
 * `ConsentBroker::request`, carries:
 *
 * - `id` — broker token the renderer must echo back via
 *   `automation_consent_respond`.
 * - `command` / `surface` / `pluginId` / `processName` / `windowTitle` —
 *   the original prompt fields, surfaced to the user verbatim.
 * - `timeoutMs` — how long the Rust side will wait before auto-rejecting.
 *   The overlay matches this with a visible countdown so the user knows
 *   exactly how long they have to decide.
 *
 * Three actions:
 *
 * 1. **Allow once** — `consentRespond({ allow: true, persist: false })`.
 * 2. **Don't ask again for N minutes** — `consentRespond({ allow: true,
 *    persist: true, prompt, grantDurationMs })`. The broker keys the grant by
 *    `(sessionKey, surface, command, pluginId, processName)` and stamps it
 *    with an expiry; identical future calls in the same conversation skip the
 *    overlay until the window lapses (or the kill switch fires).
 * 3. **Reject** — `consentRespond({ allow: false })`.
 *
 * Closing the overlay (X button) is equivalent to Reject so the broker's
 * pending channel resolves promptly rather than waiting out `timeoutMs`.
 *
 * Multiple concurrent requests are queued oldest-first. The overlay answers the
 * front of the queue and exposes a small "N more pending" pill so the user
 * knows additional decisions are stacked behind the current one.
 */

import { useTranslations } from "next-intl"
import { ShieldAlertIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import {
  CONSENT_GRANT_DURATIONS_MS,
  grantDurationMinutes,
} from "@/lib/automation/consent-durations"
import { useAutomationConsent } from "@/hooks/automation/use-automation-consent"

export function ConsentOverlay() {
  const t = useTranslations("automation.consent")
  // The queue, the countdown tick, the dedupe and the respond call all live in
  // `useAutomationConsent`, shared with the mobile sheet. This file held a
  // second copy of all four until they drifted.
  const { queue, now, respond } = useAutomationConsent({ enabled: isTauri() })

  if (!isTauri() || queue.length === 0) return null

  // Show the front of the queue. Behind it, the next prompt nests under a
  // 1px overlay shadow so the user knows more are stacked.
  const current = queue[0]
  const remaining = queue.length - 1
  const secondsLeft = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))

  // Translate the verb / surface tags. Unknown verbs fall through to the raw
  // command so an unrecognized future action still renders something usable.
  const commandLabel = t.has(`commands.${current.command}`)
    ? t(`commands.${current.command}` as Parameters<typeof t>[0])
    : current.command
  const surfaceLabel = t(`surfaces.${current.surface}` as Parameters<typeof t>[0])

  return (
    <div
      role="dialog"
      aria-label={t("ariaLabel")}
      className={cn("pointer-events-none fixed bottom-6 right-6 z-[100]", "max-w-sm")}
    >
      <Card className="pointer-events-auto shadow-xl border-amber-500/30">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlertIcon className="size-4 text-amber-500" />
              {t("title")}
            </CardTitle>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={() => respond(current, false, false)}
              aria-label={t("actions.close")}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
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
            {current.commandDetail && (
              <div className="space-y-1">
                <span className="text-muted-foreground">{t("fields.command")}</span>
                <pre className="max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                  {current.commandDetail}
                </pre>
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
            <Button size="sm" onClick={() => respond(current, true, false)}>
              {t("actions.allowOnce")}
            </Button>
            <div className="space-y-1">
              <span className="text-[10px] text-muted-foreground">
                {t("actions.allowForLabel")}
              </span>
              <div className="flex gap-1">
                {CONSENT_GRANT_DURATIONS_MS.map((ms) => (
                  <Button
                    key={ms}
                    size="sm"
                    variant="outline"
                    className="flex-1 text-[11px]"
                    onClick={() => respond(current, true, true, ms)}
                    data-testid={`consent-allow-for-${grantDurationMinutes(ms)}`}
                  >
                    {t("actions.allowForMinutes", { minutes: grantDurationMinutes(ms) })}
                  </Button>
                ))}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => respond(current, false, false)}>
              {t("actions.reject")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

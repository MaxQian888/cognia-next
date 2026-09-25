"use client"

/**
 * Floating consent overlay for the `PluginConsentBroker`.
 *
 * Plugin equivalent of `components/automation/consent-overlay.tsx`. The
 * Rust→renderer Tauri event is replaced by an in-renderer
 * `window` CustomEvent (`plugin:consent-request`) dispatched by
 * `lib/plugin/security/consent-broker.ts` whenever a plugin call hits
 * a tier-`"confirm"` permission. The overlay listens for the event,
 * renders the three-button card, and calls back via
 * `getPluginConsentBroker().respond(requestId, {...})`.
 *
 * When the request carries a `binary` subject (a plugin-shipped executable
 * about to be spawned), the card also offers a default-off "remember this
 * binary" checkbox — the sole way a durable `approvedBinaries` row is ever
 * written. All three buttons are otherwise session-scoped, so the checkbox is
 * deliberately a separate question: ticking it is the user's only affirmative
 * for durability, and leaving it alone must mean exactly what it meant before
 * the ledger existed.
 *
 * Mounted once near the app root (alongside `<PluginModalRoot />`).
 *
 * The card names the plugin by its manifest NAME (the id is secondary) and
 * says what the permission means in the user's language; it used to print the
 * bare id and the bare permission key. It is an `alertdialog`: focus moves to
 * it when a prompt arrives, and a polite live region announces who is asking
 * for what, since the prompt appears unbidden over whatever the user is doing.
 *
 * Placement: a full-width sheet above the phone's tab bar and home indicator,
 * a bottom-right card from `sm` up. The old `fixed right-6 max-w-sm` card sat
 * partly off-screen on a 375px phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { usePermissionDescription } from "@/hooks/plugins/use-permission-description"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { cn } from "@/lib/utils"
import {
  PLUGIN_CONSENT_REQUEST_EVENT,
  getPluginConsentBroker,
  type PluginConsentRequestEvent,
} from "@/lib/plugin/security/consent-broker"

interface PendingPrompt extends PluginConsentRequestEvent {
  /** Wall-clock deadline for the renderer-side countdown. */
  expiresAt: number
}

export function PluginConsentOverlay() {
  const t = useTranslations("plugins.consent")
  const [queue, setQueue] = useState<PendingPrompt[]>([])
  const [now, setNow] = useState<number>(() => Date.now())
  // Tied to a requestId rather than held as a bare boolean: the checkbox must
  // start OFF for *every* prompt, and a stale `true` leaking from the previous
  // one into the next would silently persist a binary the user never ticked.
  // Deriving it from the id resets it by construction (and avoids
  // set-state-in-effect).
  const [rememberFor, setRememberFor] = useState<{ requestId: string; value: boolean } | null>(null)
  const broker = useMemo(() => getPluginConsentBroker(), [])
  const describePermission = usePermissionDescription()
  const cardRef = useRef<HTMLDivElement>(null)
  const current = queue[0] as PendingPrompt | undefined
  const pluginName = usePluginDisplayName(current?.pluginId)
  const currentRequestId = current?.requestId

  // A prompt appears over whatever the user was doing; move focus to it so a
  // keyboard or screen-reader user is not left answering it blind. Keyed on
  // the request id, so each queued prompt takes focus when it becomes current.
  useEffect(() => {
    if (!currentRequestId) return
    cardRef.current?.focus()
  }, [currentRequestId])

  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PluginConsentRequestEvent>).detail
      if (!detail || !detail.requestId) return
      setQueue((prev) => {
        if (prev.some((p) => p.requestId === detail.requestId)) return prev
        return [...prev, { ...detail, expiresAt: Date.now() + detail.timeoutMs }]
      })
    }
    window.addEventListener(PLUGIN_CONSENT_REQUEST_EVENT, handler)
    return () => window.removeEventListener(PLUGIN_CONSENT_REQUEST_EVENT, handler)
  }, [])

  // 2Hz tick — drives the countdown and culls auto-rejected prompts.
  useEffect(() => {
    if (queue.length === 0) return
    const id = window.setInterval(() => {
      const ts = Date.now()
      setNow(ts)
      setQueue((prev) => prev.filter((p) => p.expiresAt > ts - 1000))
    }, 500)
    return () => window.clearInterval(id)
  }, [queue.length])

  const respond = useCallback(
    (prompt: PendingPrompt, allow: boolean, persist: boolean, remember = false) => {
      // Pop the prompt immediately so the user can't double-click.
      setQueue((prev) => prev.filter((p) => p.requestId !== prompt.requestId))
      setRememberFor(null)
      broker.respond(prompt.requestId, { allow, persist, remember })
    },
    [broker]
  )

  if (!current) return null

  const remaining = queue.length - 1
  const secondsLeft = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))
  const reasonText = current.reason?.trim() || t("fields.defaultReason")
  // Off unless the user ticked the box on *this* prompt.
  const remember = rememberFor?.requestId === current.requestId && rememberFor.value
  const permissionDescription = describePermission(current.permission)
  const titleId = `plugin-consent-title-${current.requestId}`
  const bodyId = `plugin-consent-body-${current.requestId}`

  return (
    <div
      className={cn(
        "pointer-events-none fixed z-[100]",
        // Phone: a full-width sheet above the tab bar and the home indicator.
        "inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]",
        // `sm` and up: the bottom-right card it always was on the desktop.
        "sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-full sm:max-w-sm"
      )}
    >
      {/* Announced once per prompt; the countdown ticking is NOT in here. */}
      <p className="sr-only" role="status" aria-live="polite">
        {t("announce", { plugin: pluginName, permission: permissionDescription })}
      </p>
      <Card
        ref={cardRef}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="pointer-events-auto max-h-[70dvh] overflow-y-auto border-amber-500/30 shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="plugin-consent-card"
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle id={titleId} className="flex min-w-0 items-center gap-2 text-sm">
              <ShieldAlertIcon className="size-4 shrink-0 text-amber-500" aria-hidden />
              <span className="min-w-0">{t("titleNamed", { plugin: pluginName })}</span>
            </CardTitle>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 pointer-coarse:size-9"
              onClick={() => respond(current, false, false)}
              aria-label={t("actions.close")}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div id={bodyId} className="space-y-1.5 text-xs">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground">{t("fields.plugin")}</span>
              <span className="min-w-0 font-medium break-words">{pluginName}</span>
              {pluginName !== current.pluginId ? (
                <code className="min-w-0 break-all font-mono text-[10px] text-muted-foreground">
                  {current.pluginId}
                </code>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">{t("fields.permission")}</span>
              <Badge variant="secondary" className="text-[10px]">
                {current.permission}
              </Badge>
              {permissionDescription !== current.permission ? (
                <span className="basis-full break-words text-[11px]">{permissionDescription}</span>
              ) : null}
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <span className="shrink-0 text-muted-foreground">{t("fields.reason")}</span>
              <span className="min-w-0 break-words text-[11px]">{reasonText}</span>
            </div>
            {current.binary && (
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground">{t("fields.binary")}</span>
                <code className="font-mono text-[11px] break-all">{current.binary.relPath}</code>
              </div>
            )}
            <div className="pt-1 text-[10px] text-muted-foreground">
              {t("fields.autoReject", { seconds: secondsLeft })}
              {remaining > 0 && (
                <span className="ml-2">{t("fields.morePending", { count: remaining })}</span>
              )}
            </div>
          </div>

          {/* Binary prompts only: the durable, hash-pinned approval. Off by
              default and answered separately from allow/reject — a session
              "yes" must never imply this one. */}
          {current.binary && (
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`remember-${current.requestId}`}
                  checked={remember}
                  onCheckedChange={(checked) =>
                    setRememberFor({ requestId: current.requestId, value: checked === true })
                  }
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <Label
                    htmlFor={`remember-${current.requestId}`}
                    className="text-xs font-medium leading-none"
                  >
                    {t("binary.rememberLabel")}
                  </Label>
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {t("binary.rememberHint")}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Button size="sm" onClick={() => respond(current, true, false, remember)}>
              {t("actions.allowOnce")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => respond(current, true, true, remember)}
            >
              {t("actions.allowSession")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => respond(current, false, false)}>
              {t("actions.reject")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

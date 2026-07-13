"use client"

/**
 * Floating consent overlay for the automation `PerCall` tier.
 *
 * Listens for `automation:consent-request` Tauri events (emitted by the
 * Rust-side `ConsentBroker::request`). Each event payload carries:
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
 * 2. **Always allow this session** — `consentRespond({ allow: true,
 *    persist: true, prompt })`. The broker keys the grant by
 *    `(surface, command, pluginId, processName)`; identical future calls
 *    skip the overlay until the kill switch is engaged.
 * 3. **Reject** — `consentRespond({ allow: false })`.
 *
 * Closing the overlay (X button) is equivalent to Reject so the broker's
 * pending channel resolves promptly rather than waiting for the 30s
 * timeout.
 *
 * Multiple concurrent requests are queued — the overlay shows the most
 * recent prompt and exposes a small "N more pending" pill so the user
 * knows additional decisions are stacked behind the current one.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { ShieldAlertIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  desktop,
  type ConsentPromptPayload,
  type ConsentRequestEvent,
} from "@/lib/automation/client"

interface PendingPrompt extends ConsentRequestEvent {
  /** Wall-clock deadline for the renderer-side countdown. */
  expiresAt: number
}

function promptOnly(event: ConsentRequestEvent): ConsentPromptPayload {
  return {
    command: event.command,
    surface: event.surface,
    pluginId: event.pluginId,
    processName: event.processName,
    windowTitle: event.windowTitle,
    commandDetail: event.commandDetail ?? null,
  }
}

export function ConsentOverlay() {
  const t = useTranslations("automation.consent")
  const [queue, setQueue] = useState<PendingPrompt[]>([])
  const [now, setNow] = useState<number>(() => Date.now())

  // Subscribe to Tauri events. The unsubscribe handle is returned by
  // `listen()`; the effect cleanup calls it. We do nothing in web mode.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false
    listen<ConsentRequestEvent>("automation:consent-request", (event) => {
      const payload = event.payload
      setQueue((prev) => {
        // Dedupe by id — Tauri can fire the same event twice across a
        // remount or HMR reload. Keep the oldest copy's deadline.
        if (prev.some((p) => p.id === payload.id)) return prev
        return [...prev, { ...payload, expiresAt: Date.now() + payload.timeoutMs }]
      })
    }).then((u) => {
      if (cancelled) {
        // StrictMode mount→unmount→mount can resolve this after cleanup ran;
        // the raw unlisten may throw on the already-gone registration.
        safeUnlisten(u)
      } else {
        unlisten = u
      }
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  // 1Hz tick so the countdown re-renders; also drops expired prompts inline
  // so we don't trigger a setState cascade from a separate effect. The Rust
  // broker has its own timeout — this is just UI tidy-up.
  useEffect(() => {
    if (queue.length === 0) return
    const id = window.setInterval(() => {
      const ts = Date.now()
      setNow(ts)
      setQueue((prev) => prev.filter((p) => p.expiresAt > ts - 1000))
    }, 500)
    return () => window.clearInterval(id)
  }, [queue.length])

  const respond = useCallback(async (event: PendingPrompt, allow: boolean, persist: boolean) => {
    // Remove the prompt from the UI immediately — Rust resolves the
    // channel async, but we don't want the user to be able to click twice.
    setQueue((prev) => prev.filter((p) => p.id !== event.id))
    try {
      await desktop.consentRespond({
        id: event.id,
        allow,
        persist,
        prompt: persist ? promptOnly(event) : undefined,
      })
    } catch (err) {
      // Best-effort — log but don't re-queue. If `respond` fails the
      // Rust-side timeout will fire eventually.
      console.warn("automation_consent_respond failed", err)
    }
  }, [])

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
            <Button size="sm" variant="outline" onClick={() => respond(current, true, true)}>
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

"use client"

// Sidecar tab — read-only diagnostics for the in-process Claude SDK sidecar.
// Polls `getSidecarStatus()` every 3s when running in Tauri; surfaces the
// most recent SDK session id from the active chat session for traceability.
// Restart button is desktop-only.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { getSidecarStatus, restartSidecar } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import { getSession } from "@/lib/db/sessions"

const POLL_INTERVAL_MS = 3000

export function SidecarTab() {
  const t = useTranslations("settings.agentRuntimeSection.sidecar")
  const desktop = isTauri()
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [sdkSessionId, setSdkSessionId] = useState<string | null>(null)

  // Status & SDK-session-id reads are external IO; the warnings about
  // synchronous setState are acceptable for this read-only diagnostics tab.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!desktop) {
      setReady(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const r = await getSidecarStatus()
        if (!cancelled) setReady(Boolean(r.ready))
      } catch {
        if (!cancelled) setReady(false)
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [desktop])

  useEffect(() => {
    let cancelled = false
    if (!activeSessionId) {
      setSdkSessionId(null)
      return
    }
    void (async () => {
      try {
        const s = await getSession(activeSessionId)
        if (!cancelled) setSdkSessionId(s?.sdkSessionId ?? null)
      } catch {
        if (!cancelled) setSdkSessionId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleRestart = async () => {
    setBusy(true)
    try {
      await restartSidecar()
      toast.success(t("restartedToast"))
      // Optimistically reset the badge until the next poll lands.
      setReady(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t("statusLabel")}</dt>
            <dd className="mt-1">
              {!desktop ? (
                <Badge variant="outline">{t("webOnly")}</Badge>
              ) : ready === true ? (
                <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  {t("running")}
                </Badge>
              ) : ready === false ? (
                <Badge variant="outline" className="bg-destructive/15 text-destructive">
                  {t("stopped")}
                </Badge>
              ) : (
                <Badge variant="outline">{t("checking")}</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("sdkSessionLabel")}</dt>
            <dd className="mt-1 truncate font-mono text-xs">{sdkSessionId ?? "—"}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Button
            onClick={() => void handleRestart()}
            disabled={!desktop || busy}
            aria-disabled={!desktop || busy}
            aria-label={t("restartBtn")}
          >
            {t("restartBtn")}
          </Button>
          {!desktop && (
            <p className="text-xs text-muted-foreground" role="status">
              {t("desktopOnlyHint")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default SidecarTab

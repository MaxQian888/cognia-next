"use client"

// ADR-0028 Phase 14 — Sidecar restart counter card.
//
// Polls `sidecar_restart_count` every 5 s and shows the count next to a
// "Last restart" stamp the user can compare with their last action.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { transport, isTauri } from "@/lib/tauri"

const POLL_MS = 5000

export function SidecarRestartCard() {
  const t = useTranslations("settings.diagnostics.sidecarRestart")
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTickAt, setLastTickAt] = useState<number | null>(null)
  const [lastRestartTs, setLastRestartTs] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!isTauri()) return
    let prev: number | null = null

    const tick = async () => {
      try {
        const value = await transport.call<number>("sidecar_restart_count", {})
        if (cancelled) return
        if (prev !== null && value > prev) {
          setLastRestartTs(Date.now())
        }
        prev = value
        setCount(value)
        setLastTickAt(Date.now())
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    void tick()
    const handle = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {error ? (
          <p className="text-rose-500" role="alert" data-testid="sidecar-restart-error">
            {error}
          </p>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("count")}</dt>
            <dd className="font-mono" data-testid="sidecar-restart-count">
              {count ?? "—"}
            </dd>
            <dt className="text-muted-foreground">{t("lastRestart")}</dt>
            <dd className="font-mono" data-testid="sidecar-restart-last">
              {lastRestartTs ? new Date(lastRestartTs).toLocaleString() : t("noRestart")}
            </dd>
            <dt className="text-muted-foreground">{t("lastChecked")}</dt>
            <dd className="font-mono">
              {lastTickAt ? new Date(lastTickAt).toLocaleTimeString() : "—"}
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

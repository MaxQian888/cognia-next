"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { executeCdpCommand, grantCdpAccess, revokeCdpAccess } from "@/lib/browser/cdp-client"
import { listCdpAuditEvents } from "@/lib/db/browser-cdp"
import type { CdpAuditEvent, CdpCapability, CdpGrant } from "@/types/browser-developer"

const CAPABILITIES: CdpCapability[] = ["dom", "runtime", "console", "network", "performance"]

export function BrowserCdpControls({
  sessionId,
  browserSessionId,
  pageUrl,
}: {
  sessionId: string
  browserSessionId: string
  pageUrl: string
}) {
  const t = useTranslations("browserCdp")
  const [capabilities, setCapabilities] = useState<Set<CdpCapability>>(new Set(["dom"]))
  const [durationMinutes, setDurationMinutes] = useState("15")
  const [grant, setGrant] = useState<CdpGrant | null>(null)
  const grantRef = useRef<CdpGrant | null>(null)
  const [audit, setAudit] = useState<CdpAuditEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  const refreshAudit = useCallback(async () => {
    setAudit(await listCdpAuditEvents(sessionId))
  }, [sessionId])
  useEffect(() => {
    let active = true
    void listCdpAuditEvents(sessionId).then(
      (events) => {
        if (active) setAudit(events)
      },
      () => {
        if (active) setAudit([])
      }
    )
    return () => {
      active = false
    }
  }, [sessionId])
  useEffect(() => {
    grantRef.current = grant
  }, [grant])
  useEffect(() => {
    return () => {
      const active = grantRef.current
      if (active) void revokeCdpAccess(active.id).catch(() => undefined)
    }
  }, [sessionId, browserSessionId, pageUrl])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try {
      await operation()
    } catch (cause) {
      setMessage({
        kind: "error",
        text: t("error", { message: cause instanceof Error ? cause.message : String(cause) }),
      })
    } finally {
      setBusy(false)
      await refreshAudit().catch(() => undefined)
    }
  }

  const createGrant = () =>
    run(async () => {
      const next = await grantCdpAccess({
        id: `cdp-grant:${crypto.randomUUID()}`,
        sessionId,
        browserSessionId,
        pageUrl,
        capabilities: [...capabilities],
        durationMs: Number(durationMinutes) * 60_000,
      })
      grantRef.current = next
      setGrant(next)
    })

  const revoke = () =>
    run(async () => {
      if (!grant) return
      await revokeCdpAccess(grant.id)
      grantRef.current = null
      setGrant(null)
    })

  const inspect = () =>
    run(async () => {
      if (!grant) return
      await executeCdpCommand(
        {
          grantId: grant.id,
          sessionId,
          browserSessionId,
          pageUrl,
          capability: "dom",
          method: "DOM.getDocument",
          executionTarget: "local",
        },
        {}
      )
      setMessage({ kind: "success", text: t("result") })
    })

  return (
    <details className="border-b p-3" data-testid="browser-cdp-controls">
      <summary className="cursor-pointer text-xs font-medium">{t("title")}</summary>
      <div className="mt-2 space-y-3">
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
        <p className="text-[10px] text-muted-foreground">{t("localOnly")}</p>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("capabilities")}</Label>
          <div className="flex flex-wrap gap-2">
            {CAPABILITIES.map((capability) => (
              <label key={capability} className="flex items-center gap-1 text-[11px]">
                <Checkbox
                  checked={capabilities.has(capability)}
                  disabled={Boolean(grant)}
                  onCheckedChange={(checked) =>
                    setCapabilities((current) => {
                      const next = new Set(current)
                      if (checked) next.add(capability)
                      else next.delete(capability)
                      return next
                    })
                  }
                />
                {t(capability)}
              </label>
            ))}
          </div>
        </div>
        {!grant ? (
          <div className="flex items-center gap-2">
            <Select value={durationMinutes} onValueChange={setDurationMinutes}>
              <SelectTrigger className="w-36" aria-label={t("duration")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 15, 60].map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {t("minutes", { count: minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={busy || capabilities.size === 0}
              onClick={() => void createGrant()}
            >
              {t("grant")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              {t("active", { time: new Date(grant.expiresAt).toLocaleTimeString() })}
            </p>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={busy || !grant.capabilities.includes("dom")}
                onClick={() => void inspect()}
              >
                {t("inspect")}
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void revoke()}>
                {t("revoke")}
              </Button>
            </div>
          </div>
        )}
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={
              message.kind === "error" ? "text-xs text-destructive" : "text-xs text-emerald-600"
            }
          >
            {message.text}
          </p>
        )}
        <div className="space-y-1">
          <Label className="text-xs">{t("audit")}</Label>
          {audit.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">{t("noAudit")}</p>
          ) : (
            audit
              .slice(-8)
              .reverse()
              .map((event) => (
                <p key={event.id} className="text-[10px] text-muted-foreground">
                  {t("auditEntry", { outcome: event.outcome, method: event.method ?? "—" })}
                </p>
              ))
          )}
        </div>
      </div>
    </details>
  )
}

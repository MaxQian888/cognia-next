"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Surface } from "@/components/surface/surface"
import { executeCdpCommand, grantCdpAccess, revokeCdpAccess } from "@/lib/browser/cdp-client"
import { listCdpAuditEvents } from "@/lib/db/browser-cdp"
import type { CdpAuditEvent, CdpCapability, CdpGrant } from "@/types/browser-developer"
import { ChevronDownIcon } from "lucide-react"

const CAPABILITIES: CdpCapability[] = ["dom", "runtime"]
/** Keep a returned value from flooding a 320px rail (and the DOM). */
const MAX_RESULT_CHARS = 4000

/** Pretty-print whatever the bridge returned; fall back to String() for cycles. */
function formatCdpValue(value: unknown): { text: string; truncated: boolean } {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  return text.length > MAX_RESULT_CHARS
    ? { text: text.slice(0, MAX_RESULT_CHARS), truncated: true }
    : { text, truncated: false }
}

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
  const [expression, setExpression] = useState("document.title")
  const [result, setResult] = useState<{ method: string; value: unknown } | null>(null)
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
    setResult(null)
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

  /**
   * Run one method and SHOW what came back. The returned `{method, value}` used
   * to be dropped on the floor in favour of a fixed "completed" string, which
   * made the whole panel indistinguishable from a no-op.
   */
  const execute = (capability: CdpCapability, method: string, params: Record<string, unknown>) =>
    run(async () => {
      if (!grant) return
      setResult(
        await executeCdpCommand(
          {
            grantId: grant.id,
            sessionId,
            browserSessionId,
            pageUrl,
            capability,
            method,
            executionTarget: "local",
          },
          params
        )
      )
    })

  const inspect = () => execute("dom", "DOM.getDocument", {})
  const evaluate = () => execute("runtime", "Runtime.evaluate", { expression })

  return (
    <Collapsible className="group/collapsible border-b p-3" data-testid="browser-cdp-controls">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-between px-0 py-1 text-xs">
          {t("title")}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/collapsible:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3">
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
            {grant.capabilities.includes("runtime") && (
              <div className="space-y-1.5">
                <Label htmlFor="cdp-expression" className="text-xs">
                  {t("expression")}
                </Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="cdp-expression"
                    value={expression}
                    onChange={(event) => setExpression(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && expression.trim()) {
                        event.preventDefault()
                        void evaluate()
                      }
                    }}
                    className="h-7 font-mono text-[11px]"
                    placeholder={t("expressionPlaceholder")}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !expression.trim()}
                    onClick={() => void evaluate()}
                  >
                    {t("evaluate")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {result && (
          <div className="space-y-1" data-testid="browser-cdp-result">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">{t("resultTitle", { method: result.method })}</Label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(formatCdpValue(result.value).text)
                    .then(() => setMessage({ kind: "success", text: t("copied") }))
                    .catch(() => undefined)
                }}
              >
                {t("copy")}
              </Button>
            </div>
            <Surface asChild layer="raised">
              <ScrollArea className="max-h-40 rounded-md border">
                <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[10px]">
                  {formatCdpValue(result.value).text}
                </pre>
              </ScrollArea>
            </Surface>
            {formatCdpValue(result.value).truncated && (
              <p className="text-[10px] text-muted-foreground">{t("valueTruncated")}</p>
            )}
          </div>
        )}
        {message && (
          <Alert variant={message.kind === "error" ? "destructive" : "default"}>
            <AlertDescription
              role={message.kind === "error" ? "alert" : "status"}
              className="text-xs"
            >
              {message.text}
            </AlertDescription>
          </Alert>
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
      </CollapsibleContent>
    </Collapsible>
  )
}

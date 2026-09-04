"use client"

/**
 * Watch the connected host's automation engine from a phone, and stop it.
 *
 * This is the surface the mobile Computer Use page used to lack. It embedded
 * the desktop `<AutomationSection>`, every tab of which gates on `isTauri()`,
 * so the whole page was one toggle above a notice telling the reader to run a
 * build command.
 *
 * The reads reach the host over the companion RPC plane. Driving the desktop
 * still does not cross the wire, and neither does editing the access rules, so
 * this panel is exactly what a supervisor can do: see the engine's state, see
 * what it decided, and halt it.
 *
 * Halting needs the remote-control capability, the same one the consent sheet
 * needs. Without it the button stays visible and disabled with the reason
 * beside it, rather than vanishing: a control that is one grant away reads
 * very differently from one that never existed.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, OctagonXIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useCanControl } from "@/hooks/data/use-can-control"
import type { AuditDecision, Tier } from "@/lib/automation/client"
import {
  haltAutomation,
  readAutomationSupervision,
  type AutomationSupervisionSnapshot,
} from "@/lib/automation/supervision"

const RECENT_LIMIT = 20

const DECISION_VARIANT: Record<AuditDecision, "secondary" | "destructive" | "outline"> = {
  allow: "secondary",
  deny: "destructive",
  consent: "outline",
}

export function HostAutomationPanel() {
  const t = useTranslations("mobile.automation.host")
  const tCommon = useTranslations("common")
  const canControl = useCanControl()
  const [snapshot, setSnapshot] = useState<AutomationSupervisionSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreachable, setUnreachable] = useState(false)
  const [halting, setHalting] = useState(false)
  const [nonce, setNonce] = useState(0)

  // `loading` is raised by whatever asked for the read (the initial state, or
  // `refresh`), never inside this effect: a synchronous setState in an effect
  // body cascades a render.
  useEffect(() => {
    let cancelled = false
    readAutomationSupervision(RECENT_LIMIT)
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setUnreachable(false)
      })
      .catch(() => {
        if (cancelled) return
        // Any failure here means the same thing to the reader: there is no host
        // answering. The specific transport error is not actionable on a phone.
        setUnreachable(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const refresh = useCallback(() => {
    setLoading(true)
    setNonce((n) => n + 1)
  }, [])

  const halt = useCallback(async () => {
    setHalting(true)
    try {
      await haltAutomation()
      toast.success(t("haltDone"))
      refresh()
    } catch (err) {
      toast.error(t("haltFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setHalting(false)
    }
  }, [t, refresh])

  if (loading && !snapshot) {
    return (
      <Card data-testid="host-automation-loading">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <CardDescription className="text-xs">{t("loading")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (unreachable || !snapshot) {
    return (
      <Alert data-testid="host-automation-unreachable">
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        <AlertTitle>{t("unreachableTitle")}</AlertTitle>
        <AlertDescription>{t("unreachableDescription")}</AlertDescription>
      </Alert>
    )
  }

  const tierLabel = tierText(snapshot.defaultTier, t)

  return (
    <Card data-testid="host-automation-panel">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">{t("title")}</CardTitle>
            <CardDescription className="text-xs">{t("description")}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={t("refresh")}
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={snapshot.enabled && !snapshot.killSwitchEngaged ? "secondary" : "outline"}
            data-testid="host-engine-state"
          >
            {snapshot.enabled ? t("engineOn") : t("engineOff")}
          </Badge>
          {snapshot.killSwitchEngaged && (
            <Badge variant="destructive" data-testid="host-halted">
              {t("halted")}
            </Badge>
          )}
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t("tier", { tier: tierLabel })}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CountCell label={t("countsTotal")} value={snapshot.counts.total} />
          <CountCell label={t("countsAllow")} value={snapshot.counts.allow} />
          <CountCell label={t("countsDeny")} value={snapshot.counts.deny} />
          <CountCell label={t("countsConsent")} value={snapshot.counts.consent} />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">{t("recentTitle")}</p>
          {snapshot.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="host-recent-empty">
              {t("recentEmpty")}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="host-recent-list">
              {snapshot.recent.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
                >
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {new Date(row.ts).toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {row.command}
                  </span>
                  <Badge
                    variant={DECISION_VARIANT[row.decision]}
                    className="shrink-0 text-[10px]"
                  >
                    {row.decision}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="w-full"
                disabled={canControl !== true || halting}
                data-testid="host-halt-button"
              >
                <OctagonXIcon className="size-4" aria-hidden="true" />
                {t("halt")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("halt")}</AlertDialogTitle>
                <AlertDialogDescription>{t("haltConfirm")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void halt()}>{t("halt")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {canControl !== true && (
            <p className="text-xs text-muted-foreground" data-testid="host-halt-forbidden">
              {t("haltForbidden")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CountCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border px-2 py-1.5">
      <p className="truncate text-[10px] text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  )
}

function tierText(tier: Tier, t: (key: string) => string): string {
  if (tier === "off") return t("tierOff")
  if (tier === "whitelist") return t("tierWhitelist")
  return t("tierPerCall")
}

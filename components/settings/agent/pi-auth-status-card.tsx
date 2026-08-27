"use client"

import { useTranslations } from "next-intl"
import { KeyRound, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { usePiAuthStatus } from "@/hooks/agent/use-pi-auth-status"
import type { PiAuthProbeStatus } from "@/lib/ai/agent/external/pi-auth"

interface PiAuthStatusCardProps {
  agentId: string
  connected: boolean
}

const ICONS: Record<PiAuthProbeStatus, typeof ShieldCheck> = {
  ready: ShieldCheck,
  not_ready: ShieldAlert,
  invalid: ShieldAlert,
  unreadable: ShieldQuestion,
}

const VARIANTS: Record<PiAuthProbeStatus, "default" | "outline" | "destructive"> = {
  ready: "default",
  not_ready: "destructive",
  invalid: "destructive",
  unreadable: "outline",
}

/**
 * Pi credential diagnostic (ADR-0119).
 *
 * ADR-0119 sanctioned exactly one way to ask about Pi's credentials —
 * `pi auth check --provider <id> --json --no-refresh` — and then shipped no
 * caller, so "Pi is installed but signed into nothing" was only discoverable by
 * sending a prompt and watching it fail. This card is that missing caller.
 *
 * Three distinctions the rendering has to preserve, because collapsing any of
 * them turns a diagnosis into a wrong answer:
 *
 *  - **unreadable is not unauthenticated.** Pi exits `1` both for "no
 *    credentials" and for "Cognia called the CLI wrong", so a probe with no
 *    parseable verdict renders as "could not check", never as a failure.
 *  - **an empty provider list is an answer, a failed listing is not.** The
 *    former is the headline diagnosis; the latter must say so.
 *  - **Cognia never sees a credential.** The card shows a status and an auth
 *    *type* (`api_key` / `oauth`); the flags that would print the secret itself
 *    are refused at the argv builder, not here.
 */
export function PiAuthStatusCard({ agentId, connected }: PiAuthStatusCardProps) {
  const t = useTranslations("externalAgent.settings.piAuth")
  const { status, loading, available, refresh } = usePiAuthStatus(agentId, connected)

  if (!connected || !available) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t("notConnected")}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="pi-auth-status">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 shrink items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="truncate text-sm font-medium">{t("title")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="pi-auth-refresh"
          aria-label={t("refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t("readOnlyNote")}</p>

      {status.listing === "unreadable" ? (
        <p className="text-xs text-muted-foreground" data-testid="pi-auth-listing-unreadable">
          {t("listingUnreadable")}
        </p>
      ) : status.verdicts.length === 0 ? (
        <p className="text-xs text-destructive" data-testid="pi-auth-no-providers">
          {t("noProviders")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {status.verdicts.map((verdict, index) => {
            const Icon = ICONS[verdict.status]
            return (
              <div
                key={`${verdict.provider ?? "unknown"}:${index}`}
                className="flex items-center justify-between gap-2"
                data-testid="pi-auth-provider"
              >
                <div className="flex min-w-0 shrink items-center gap-1.5">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs">
                    {verdict.provider ?? t("unknownProvider")}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {verdict.authType && (
                    <Badge variant="outline" className="text-[10px]">
                      {t(`authType.${verdict.authType}`)}
                    </Badge>
                  )}
                  <Badge variant={VARIANTS[verdict.status]} className="text-[10px]">
                    {t(`status.${verdict.status}`)}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {status.listing === "ok" &&
        status.verdicts.some((verdict) => verdict.reason === "credentials_not_configured") && (
          <p className="text-xs text-muted-foreground" data-testid="pi-auth-hint">
            {t("configureHint")}
          </p>
        )}
    </div>
  )
}

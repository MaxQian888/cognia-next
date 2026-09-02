"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRound, LogIn, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { usePiAuthStatus } from "@/hooks/agent/use-pi-auth-status"
import type { PiAuthProbeStatus, PiListedModel } from "@/lib/ai/agent/external/pi-auth"
import { terminalAvailable } from "@/lib/terminal/pick-transport"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

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
/** Models grouped by provider, in listing order. */
function groupModels(models: readonly PiListedModel[]): Array<[string, PiListedModel[]]> {
  const groups = new Map<string, PiListedModel[]>()
  for (const model of models) {
    const list = groups.get(model.provider) ?? []
    list.push(model)
    groups.set(model.provider, list)
  }
  return [...groups.entries()]
}

export function PiAuthStatusCard({ agentId, connected }: PiAuthStatusCardProps) {
  const t = useTranslations("externalAgent.settings.piAuth")
  const { status, loading, available, refresh } = usePiAuthStatus(agentId, connected)
  const cwd = useExternalAgentStore((s) => s.agents[agentId]?.process?.cwd ?? "")
  const [signingIn, setSigningIn] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const groups = useMemo(() => groupModels(status.models), [status.models])
  // Same gate the composer uses before handing an interactive command to the
  // dock: a shell that is not reachable gets a disabled button that says why,
  // never a silent nothing.
  const canOpenTerminal = terminalAvailable()

  /**
   * Sign in where Pi keeps its credentials: in Pi. Cognia opens Pi's own TUI
   * in the integrated terminal, and the user runs `/login <provider>` there.
   * Cognia never types, reads or stores the credential (ADR-0119).
   */
  const openSignIn = async () => {
    setSigningIn(true)
    try {
      await runInTerminalDock("pi", cwd, "")
      toast.message(t("signInOpened"))
    } catch (error) {
      toast.error(
        t("signInFailed", { reason: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setSigningIn(false)
    }
  }

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
                  {verdict.evidence === "model_listing" && (
                    <Badge
                      variant="outline"
                      className="text-[10px]"
                      title={t("evidenceListingTitle")}
                      data-testid="pi-auth-evidence-listing"
                    >
                      {t("evidenceListing")}
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void openSignIn()}
          disabled={!canOpenTerminal || signingIn}
          data-testid="pi-auth-sign-in"
          title={canOpenTerminal ? undefined : t("signInNeedsTerminal")}
        >
          <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
          {t("signIn")}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {canOpenTerminal ? t("signInHint") : t("signInNeedsTerminal")}
        </span>
      </div>

      {status.listing === "ok" && status.models.length > 0 && (
        <div className="space-y-1" data-testid="pi-auth-models">
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setModelsOpen((open) => !open)}
            aria-expanded={modelsOpen}
            data-testid="pi-auth-models-toggle"
          >
            {t("modelsSummary", { count: status.models.length, providers: groups.length })}
          </button>
          {modelsOpen && (
            <ul className="space-y-1">
              {groups.map(([provider, models]) => (
                <li key={provider} className="text-xs">
                  <span className="font-medium">{provider}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    {models.map((model) => model.id).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

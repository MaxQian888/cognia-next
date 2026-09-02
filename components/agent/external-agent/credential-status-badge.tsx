"use client"

/**
 * Is this agent signed in? Answered where the agent is chosen.
 *
 * The diagnostic itself already existed (ADR-0119: `pi auth check --provider
 * <id> --json --no-refresh`, wrapped by `usePiAuthStatus`) and already ran on
 * connect. It was only ever rendered inside the external-agent settings page,
 * which is not where anybody picks a runtime, so the one place the answer
 * mattered kept showing a connected agent that could not serve a single turn.
 *
 * Three distinctions carried over from the full card, because collapsing any of
 * them turns a diagnosis into a wrong answer:
 *
 *  - **unreadable is not unauthenticated.** Pi exits `1` both for "no
 *    credentials" and for "Cognia called the CLI wrong", so a probe with no
 *    parseable verdict says "could not check".
 *  - **no providers at all is a headline, not an empty list to skip past.** It
 *    reads as `none`, the same as providers with nobody signed in, because the
 *    consequence is the same: this agent cannot serve a turn. The tooltip is
 *    where the two come apart, listing the providers when there are any.
 *  - **partial is its own state.** One signed-in provider out of four is a
 *    working agent for some models and a dead end for the rest.
 *
 * Renders nothing for an agent that has no credential probe, which is every
 * agent except Pi today. An absent badge means "not asked", never "fine".
 */

import { useTranslations } from "next-intl"
import { KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePiAuthStatus } from "@/hooks/agent/use-pi-auth-status"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { cn } from "@/lib/utils"

export type CredentialState = "ready" | "partial" | "none" | "unreadable" | "checking"

const VISUALS: Record<
  Exclude<CredentialState, "checking">,
  { Icon: typeof KeyRound; tone: string }
> = {
  ready: { Icon: ShieldCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  partial: { Icon: ShieldAlert, tone: "text-amber-600 dark:text-amber-400" },
  none: { Icon: ShieldAlert, tone: "text-destructive" },
  unreadable: { Icon: ShieldQuestion, tone: "text-muted-foreground" },
}

/** Pure so the state machine is testable without a live Pi process. */
export function resolveCredentialState(input: {
  loading: boolean
  listing: "ok" | "unreadable" | "idle"
  ready: number
  total: number
}): CredentialState | null {
  if (input.listing === "idle") return input.loading ? "checking" : null
  if (input.listing === "unreadable") return "unreadable"
  // No providers at all and providers with none signed in are the same verdict
  // for the badge: this agent cannot serve a turn. `total === 0` needs no branch
  // of its own, because `ready` counts a subset and is 0 whenever `total` is.
  if (input.ready === 0) return "none"
  return input.ready === input.total ? "ready" : "partial"
}

export function AgentCredentialBadge({
  agentId,
  className,
}: {
  agentId: string
  className?: string
}) {
  const t = useTranslations("externalAgent.credential")
  const connected = useExternalAgentStore(
    (s) => (s.connectionStatus[agentId] ?? "disconnected") === "connected"
  )
  const { status, loading, available } = usePiAuthStatus(agentId, connected)

  if (!available) return null

  const ready = status.verdicts.filter((verdict) => verdict.status === "ready").length
  const state = resolveCredentialState({
    loading,
    listing: status.listing,
    ready,
    total: status.verdicts.length,
  })
  if (!state) return null

  if (state === "checking") {
    return (
      <span className={cn("text-[10px] text-muted-foreground", className)}>{t("checking")}</span>
    )
  }

  const visual = VISUALS[state]
  const label =
    state === "partial"
      ? t("partial", { ready, total: status.verdicts.length })
      : t(state === "ready" ? "ready" : state === "none" ? "none" : "unreadable")

  const badge = (
    <Badge
      variant="outline"
      className={cn("gap-1 text-[10px] font-normal", className)}
      data-credential={state}
    >
      <visual.Icon className={cn("h-3 w-3", visual.tone)} aria-hidden="true" />
      {label}
    </Badge>
  )

  const detail = status.verdicts
    .map((verdict) => `${verdict.provider ?? "?"}: ${verdict.status}`)
    .join("\n")
  if (!detail) return badge

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line text-[11px]">{detail}</TooltipContent>
    </Tooltip>
  )
}

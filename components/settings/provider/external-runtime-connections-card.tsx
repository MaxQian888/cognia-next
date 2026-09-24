"use client"

/**
 * The agents on this machine that do not need a provider key from this page.
 *
 * Sits above the built-in provider list on AI Connections. Without it, a user
 * running everything through Pi or another external agent saw a wall of
 * "Unconfigured" providers and no sign that turns were working, or of where
 * those agents' credentials actually live. Each row says whether the agent is
 * connected (or ready on the paired host) and, through the same credential
 * probe the runtime picker shows, whether it is signed in; the footer links to
 * External Agents, which owns their configuration.
 *
 * Renders nothing when no external agent is configured on this device or its
 * host: an empty card would be noise for a user who only uses built-in
 * providers.
 */

import Link from "next/link"
import { ArrowRightIcon, BotIcon, Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentCredentialBadge } from "@/components/agent/external-agent/credential-status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type {
  ExternalRuntimeConnection,
  ExternalRuntimeConnections,
  ExternalRuntimeState,
} from "./use-external-runtime-connections"

/** The External Agents settings section, which owns these agents' credentials. */
export const EXTERNAL_AGENTS_SETTINGS_HREF = "/settings?section=agents"

const STATE_BADGE_CLASS: Record<ExternalRuntimeState, string> = {
  connected: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  ready: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  connecting: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  checking: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  blocked: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "border-transparent bg-destructive/15 text-destructive",
  off: "border-transparent bg-muted text-muted-foreground",
}

function RuntimeRow({ row }: { row: ExternalRuntimeConnection }) {
  const tStates = useTranslations("externalAgent.readiness.states")
  const t = useTranslations("providers.externalRuntimes")
  const busy = row.state === "connecting" || row.state === "checking"
  return (
    <li
      className="flex min-w-0 flex-col gap-1 py-2 @md/provider-runtimes:flex-row @md/provider-runtimes:items-center @md/provider-runtimes:gap-3"
      data-testid={`external-runtime-row-${row.key}`}
      data-state={row.state}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium">{row.name}</span>
        {row.protocolLabel && (
          <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] font-normal">
            {row.protocolLabel}
          </Badge>
        )}
        {row.placement !== "local" && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{t("runsOnHost")}</span>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("gap-1 font-normal", STATE_BADGE_CLASS[row.state])}
          data-testid={`external-runtime-state-${row.key}`}
        >
          {busy && <Loader2Icon className="size-3 animate-spin" aria-hidden />}
          {tStates(row.state)}
        </Badge>
        {/* The Pi sign-in probe. Renders nothing for agents without one, which
            reads as "not asked", never as "fine". */}
        {row.localAgentId && <AgentCredentialBadge agentId={row.localAgentId} />}
      </div>
      {row.detail && (
        <p className="w-full text-[11px] text-muted-foreground @md/provider-runtimes:basis-full">
          {row.detail}
        </p>
      )}
    </li>
  )
}

export function ExternalRuntimeConnectionsCard({
  connections,
  className,
}: {
  connections: ExternalRuntimeConnections
  className?: string
}) {
  const t = useTranslations("providers.externalRuntimes")
  const { rows, configuredCount, externalEnabled, workingCount } = connections
  const switchedOff = !externalEnabled && configuredCount > 0
  if (rows.length === 0 && !switchedOff) return null

  return (
    <section
      className={cn("@container/provider-runtimes rounded-lg border px-4 py-3", className)}
      aria-labelledby="external-runtime-connections-title"
      data-testid="external-runtime-connections"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="external-runtime-connections-title" className="text-sm font-medium">
              {t("title")}
            </h3>
            {rows.length > 0 && (
              <Badge
                variant="secondary"
                className="h-5 px-1.5 text-[10px] font-normal"
                data-testid="external-runtime-summary"
              >
                {t("summary", { working: workingCount, total: rows.length })}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      {switchedOff && (
        <p
          className="mt-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"
          data-testid="external-runtime-switched-off"
        >
          {t("switchedOff", { count: configuredCount })}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-2 divide-y" aria-label={t("listAria")}>
          {rows.map((row) => (
            <RuntimeRow key={row.key} row={row} />
          ))}
        </ul>
      )}

      <div className="mt-2 flex justify-end">
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          <Link href={EXTERNAL_AGENTS_SETTINGS_HREF}>
            {t("manage")}
            <ArrowRightIcon className="size-3" aria-hidden />
          </Link>
        </Button>
      </div>
    </section>
  )
}

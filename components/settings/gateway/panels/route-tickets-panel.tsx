"use client"

/**
 * Settings → Gateway → Route tickets (ADR-0090 Phase 2).
 *
 * Session-scoped frozen routes. `gateway_mint_route_ticket` /
 * `gateway_revoke_route_ticket` / `gateway_list_route_tickets` had existed
 * since Phase 2 with zero callers anywhere in the app, because the
 * `gatewayAgentRouteTickets` flag defaults OFF and nothing ever wrote the
 * localStorage layer that could turn it on — env at build time was the only
 * lever. This panel is the first reader AND, via `setAgentExecutionFlag`, the
 * first writer; the issuer this list reflects is
 * `lib/gateway/mint-session-ticket.ts`, called from `buildSendOptions` once a
 * spec resolves to a gateway route.
 *
 * Working Rule 7 (dormancy on all three axes) is why the flag-off state renders
 * an explicit "not enabled" surface rather than a plain empty list: an empty
 * list would read as "no tickets right now", which is indistinguishable from
 * the capability being switched off, and is exactly the failure this repo keeps
 * hitting. Pinned by `route-tickets-panel.test.tsx`.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, RefreshCwIcon, TicketIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsToggle,
} from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  isAgentExecutionFlagEnabled,
  setAgentExecutionFlag,
  subscribeToAgentExecutionFlags,
} from "@/lib/ai/agent/execution/feature-flags"
import { gatewayListRouteTickets, gatewayRevokeRouteTicket } from "@/lib/tauri/gateway"
import type { GatewayRouteTicket } from "@/types/gateway"

/**
 * Prerender snapshot for the route-ticket flag.
 *
 * The flag resolves through localStorage, which does not exist while the page
 * is statically exported — so the prerendered HTML must claim "off". Returning
 * anything else would make the server and the first client render disagree for
 * any user who had turned it on, which React reports as a hydration mismatch.
 */
export function routeTicketsDisabledDuringPrerender(): boolean {
  return false
}

export function GatewayRouteTicketsPanel() {
  const t = useTranslations("settings.gateway.tickets")
  const [tickets, setTickets] = useState<GatewayRouteTicket[]>([])
  const [loaded, setLoaded] = useState(false)

  // The flag lives in localStorage, which does not exist while the page is
  // prerendered. `useSyncExternalStore` gives the prerender a stable `false`
  // and swaps to the real value on hydration — without the mount-effect
  // setState that mirroring into component state would need.
  const enabled = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled("gatewayAgentRouteTickets"),
    routeTicketsDisabledDuringPrerender
  )

  // Promise callbacks rather than async/await: every setState below then lands
  // in an external-system callback instead of reading as a synchronous write
  // from the effect body (react-hooks/set-state-in-effect).
  const refresh = useCallback(
    () =>
      gatewayListRouteTickets()
        .then(setTickets)
        // The gateway may simply not be running; an empty list is the honest
        // rendering and the panel already explains the prerequisites.
        .catch(() => setTickets([]))
        .finally(() => setLoaded(true)),
    []
  )

  useEffect(() => {
    if (!enabled) return
    void refresh()
  }, [enabled, refresh])

  const onToggle = useCallback((next: boolean) => {
    // The store notifies its subscribers, and the snapshot re-reads the
    // resolved value — so a private-mode / quota failure surfaces as the toggle
    // snapping back rather than as a false "on".
    setAgentExecutionFlag("gatewayAgentRouteTickets", next)
  }, [])

  const onRevoke = useCallback(
    async (ticketId: string) => {
      try {
        await gatewayRevokeRouteTicket(ticketId)
        await refresh()
        toast.success(t("revoked"))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh, t]
  )

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<TicketIcon className="size-4" />}
        title={t("title")}
        description={t("description")}
        badge={t("experimentalBadge")}
        badgeVariant="outline"
      >
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("routingWarning")}</span>
        </div>

        <SettingsToggle
          id="gw-route-tickets-enabled"
          label={t("enableLabel")}
          description={t("enableHelp")}
          checked={enabled}
          onCheckedChange={onToggle}
        />
      </SettingsCard>

      <MotionCollapse open={!enabled}>
        <SettingsEmptyState
          icon={<TicketIcon className="size-5" />}
          title={t("disabledTitle")}
          description={t("disabledDescription")}
        />
      </MotionCollapse>

      <MotionCollapse open={enabled}>
        <SettingsCard
          title={t("activeHeading")}
          description={t("activeHelp")}
          headerAction={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              data-testid="gateway-tickets-refresh"
            >
              <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden />
              {t("refresh")}
            </Button>
          }
        >
          {!loaded ? (
            // Distinct from the empty state on purpose: rendering the (empty)
            // list container while the first read is still in flight claims
            // "no tickets" before anything has been read.
            <div className="space-y-1" data-testid="gateway-tickets-loading" aria-busy="true">
              <div className="h-7 animate-pulse rounded bg-muted" />
              <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          ) : tickets.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="gateway-tickets-empty">
              {t("noneActive")}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="gateway-tickets">
              {tickets.map((ticket, index) => (
                <MotionReveal key={ticket.ticketId} index={index}>
                  <li className="space-y-1 rounded bg-muted px-2 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono">{ticket.ticketId}</span>
                      <Badge variant={ticket.revoked ? "destructive" : "secondary"}>
                        {ticket.revoked ? t("statusRevoked") : ticket.credentialAffinity}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ticket.revoked}
                        onClick={() => void onRevoke(ticket.ticketId)}
                        aria-label={t("revokeAria", { id: ticket.ticketId })}
                      >
                        {t("revoke")}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {t("ticketMeta", {
                        session: ticket.sessionId,
                        candidates: ticket.candidates.length,
                        expires: new Date(ticket.expiresAtMs).toLocaleTimeString(),
                      })}
                    </p>
                  </li>
                </MotionReveal>
              ))}
            </ul>
          )}
        </SettingsCard>
      </MotionCollapse>
    </div>
  )
}

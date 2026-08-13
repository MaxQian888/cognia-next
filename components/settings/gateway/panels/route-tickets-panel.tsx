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

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, RefreshCwIcon, TicketIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useAgentExecutionFlag } from "@/hooks/agent/use-agent-execution-flag"
import { setAgentExecutionFlag } from "@/lib/ai/agent/execution/feature-flags"
import { gatewayListRouteTickets, gatewayRevokeRouteTicket } from "@/lib/tauri/gateway"
import type { GatewayRouteTicket } from "@/types/gateway"

import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"

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
  const enabled = useAgentExecutionFlag("gatewayAgentRouteTickets")

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
    <GatewayPanelStack>
      <GatewayPanelSection
        icon={<TicketIcon className="size-4" />}
        title={t("title")}
        description={t("description")}
        badge={t("experimentalBadge")}
        badgeVariant="outline"
      >
        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>{t("routingWarning")}</AlertDescription>
        </Alert>

        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel htmlFor="gw-route-tickets-enabled">{t("enableLabel")}</FieldLabel>
            <FieldDescription>{t("enableHelp")}</FieldDescription>
          </FieldContent>
          <Switch id="gw-route-tickets-enabled" checked={enabled} onCheckedChange={onToggle} />
        </Field>
      </GatewayPanelSection>

      <div>
        <MotionCollapse open={!enabled}>
          <SettingsEmptyState
            icon={<TicketIcon className="size-5" />}
            title={t("disabledTitle")}
            description={t("disabledDescription")}
          />
        </MotionCollapse>

        <MotionCollapse open={enabled}>
          <GatewayPanelSection
            title={t("activeHeading")}
            description={t("activeHelp")}
            action={
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
              <div
                className="flex flex-col gap-2"
                data-testid="gateway-tickets-loading"
                aria-busy="true"
              >
                <Skeleton className="h-10" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            ) : tickets.length === 0 ? (
              <div data-testid="gateway-tickets-empty">
                <SettingsEmptyState
                  icon={<TicketIcon className="size-5" />}
                  title={t("noneActive")}
                  className="py-6"
                />
              </div>
            ) : (
              <ItemGroup data-testid="gateway-tickets">
                {tickets.map((ticket, index) => (
                  <MotionReveal key={ticket.ticketId} index={index}>
                    <Item role="listitem" size="sm" variant="muted">
                      <ItemContent className="min-w-0">
                        <ItemTitle className="truncate font-mono text-xs">
                          {ticket.ticketId}
                        </ItemTitle>
                        <ItemDescription className="line-clamp-none text-[11px]">
                          {t("ticketMeta", {
                            session: ticket.sessionId,
                            candidates: ticket.candidates.length,
                            expires: new Date(ticket.expiresAtMs).toLocaleTimeString(),
                          })}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="max-w-full flex-wrap">
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
                      </ItemActions>
                    </Item>
                  </MotionReveal>
                ))}
              </ItemGroup>
            )}
          </GatewayPanelSection>
        </MotionCollapse>
      </div>
    </GatewayPanelStack>
  )
}

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
 *
 * Each ticket expands to what it actually grants — operations, budget and its
 * spend, the frozen candidate chain and model bindings. All of it came back
 * from `gateway_list_route_tickets`; only the id, session and expiry were
 * shown, which is not enough to decide whether to revoke one. Revoking cuts a
 * live agent session off mid-run, so it asks first.
 */

import { useCallback, useEffect, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  TicketIcon,
} from "lucide-react"
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
import { cn } from "@/lib/utils"
import type { GatewayRouteTicket, GatewayTicketOperation } from "@/types/gateway"

import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"
import { SinceTime } from "../shared/since-time"

/** Tickets expire and get minted on their own; re-read this often while visible. */
const TICKET_POLL_MS = 15_000

/** What a ticket minted before operation scoping existed may do (Rust default). */
export const LEGACY_TICKET_OPERATIONS: readonly GatewayTicketOperation[] = [
  "chat",
  "count-tokens",
  "models",
]

export function GatewayRouteTicketsPanel() {
  const t = useTranslations("settings.gateway.tickets")
  const [tickets, setTickets] = useState<GatewayRouteTicket[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

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
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh()
    }, TICKET_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  const onToggle = useCallback((next: boolean) => {
    // The store notifies its subscribers, and the snapshot re-reads the
    // resolved value — so a private-mode / quota failure surfaces as the toggle
    // snapping back rather than as a false "on".
    setAgentExecutionFlag("gatewayAgentRouteTickets", next)
  }, [])

  const onManualRefresh = useCallback(() => {
    setRefreshing(true)
    void refresh().finally(() => setRefreshing(false))
  }, [refresh])

  const onRevoke = useCallback(
    async (ticketId: string) => {
      setRevokingId(ticketId)
      try {
        await gatewayRevokeRouteTicket(ticketId)
        setConfirmRevokeId(null)
        await refresh()
        toast.success(t("revoked"))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setRevokingId(null)
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
            badge={tickets.length > 0 ? String(tickets.length) : undefined}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={refreshing}
                onClick={onManualRefresh}
                data-testid="gateway-tickets-refresh"
              >
                <RefreshCwIcon
                  className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")}
                  aria-hidden
                />
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
              <ItemGroup className="gap-2" data-testid="gateway-tickets">
                {tickets.map((ticket, index) => (
                  <MotionReveal key={ticket.ticketId} index={index}>
                    <TicketRow
                      ticket={ticket}
                      expanded={expandedId === ticket.ticketId}
                      confirmingRevoke={confirmRevokeId === ticket.ticketId}
                      revoking={revokingId === ticket.ticketId}
                      onToggleExpanded={() =>
                        setExpandedId((cur) => (cur === ticket.ticketId ? null : ticket.ticketId))
                      }
                      onToggleRevoke={() =>
                        setConfirmRevokeId((cur) =>
                          cur === ticket.ticketId ? null : ticket.ticketId
                        )
                      }
                      onRevoke={() => void onRevoke(ticket.ticketId)}
                    />
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

function TicketRow({
  ticket,
  expanded,
  confirmingRevoke,
  revoking,
  onToggleExpanded,
  onToggleRevoke,
  onRevoke,
}: {
  ticket: GatewayRouteTicket
  expanded: boolean
  confirmingRevoke: boolean
  revoking: boolean
  onToggleExpanded: () => void
  onToggleRevoke: () => void
  onRevoke: () => void
}) {
  const t = useTranslations("settings.gateway.tickets")
  const format = useFormatter()
  const now = useNow({ updateInterval: 15_000 })
  const revoked = Boolean(ticket.revoked)
  const operations = ticket.operations ?? LEGACY_TICKET_OPERATIONS
  const budget = ticket.budget
  const bindings = Object.entries(ticket.modelBindings)
  const detailId = `gw-ticket-detail-${ticket.ticketId}`

  return (
    <Item
      role="listitem"
      size="sm"
      variant="muted"
      className={cn("items-start", revoked && "opacity-70")}
    >
      <ItemContent className="min-w-0 basis-56">
        <ItemTitle className="w-full min-w-0 flex-wrap">
          <span className="truncate font-mono text-xs">{ticket.ticketId}</span>
          <Badge variant={revoked ? "destructive" : "secondary"} className="text-[10px]">
            {revoked ? t("statusRevoked") : ticket.credentialAffinity}
          </Badge>
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-[11px]">
          {/* Rust sweeps expired tickets on the next list, which can be up to a
              poll away — until then say "expired", not "expires 5 seconds ago". */}
          {ticket.expiresAtMs <= now.getTime()
            ? t("ticketMetaExpired", {
                session: ticket.sessionId,
                candidates: ticket.candidates.length,
              })
            : t("ticketMeta", {
                session: ticket.sessionId,
                candidates: ticket.candidates.length,
                expires: format.relativeTime(new Date(ticket.expiresAtMs), now),
              })}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="max-w-full flex-wrap justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={detailId}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
              expanded && "rotate-90"
            )}
            aria-hidden
          />
          {t("details")}
        </Button>
        <Button
          size="sm"
          variant={confirmingRevoke ? "secondary" : "ghost"}
          disabled={revoked || revoking}
          onClick={onToggleRevoke}
          aria-expanded={confirmingRevoke}
          aria-label={t("revokeAria", { id: ticket.ticketId })}
        >
          {t("revoke")}
        </Button>
      </ItemActions>

      <div className="w-full basis-full">
        <MotionCollapse open={confirmingRevoke}>
          <Alert variant="destructive" className="mt-1">
            <AlertDescription className="flex w-full flex-col gap-2 @md/gateway-pane:flex-row @md/gateway-pane:items-center">
              <p className="flex-1">{t("revokeConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={revoking} onClick={onRevoke}>
                  {revoking ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
                  {t("revokeConfirmAction")}
                </Button>
                <Button size="sm" variant="ghost" onClick={onToggleRevoke}>
                  {t("cancel")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </MotionCollapse>

        <MotionCollapse open={expanded}>
          <dl
            id={detailId}
            className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-2 text-[11px]"
            data-testid={`gateway-ticket-detail-${ticket.ticketId}`}
          >
            <dt className="text-muted-foreground">{t("detailPolicy")}</dt>
            <dd className="truncate">{ticket.routePolicy}</dd>

            {ticket.parentSessionId ? (
              <>
                <dt className="text-muted-foreground">{t("detailParentSession")}</dt>
                <dd className="truncate font-mono">{ticket.parentSessionId}</dd>
              </>
            ) : null}

            <dt className="text-muted-foreground">{t("detailOperations")}</dt>
            <dd className="flex flex-wrap gap-1">
              {operations.map((operation) => (
                <Badge key={operation} variant="outline" className="font-mono text-[10px]">
                  {operation}
                </Badge>
              ))}
            </dd>

            <dt className="text-muted-foreground">{t("detailBudget")}</dt>
            <dd data-testid={`gateway-ticket-budget-${ticket.ticketId}`}>
              {budget &&
              (budget.maxTokens != null ||
                budget.maxRequests != null ||
                budget.maxRequestsPerMin != null) ? (
                <ul className="flex flex-col gap-0.5">
                  {budget.maxTokens != null ? (
                    <li>
                      {t("budgetTokens", {
                        spent: format.number(budget.spentTokens ?? 0),
                        max: format.number(budget.maxTokens),
                      })}
                    </li>
                  ) : null}
                  {budget.maxRequests != null ? (
                    <li>
                      {t("budgetRequests", {
                        spent: format.number(budget.spentRequests ?? 0),
                        max: format.number(budget.maxRequests),
                      })}
                    </li>
                  ) : null}
                  {budget.maxRequestsPerMin != null ? (
                    <li>{t("budgetRate", { max: budget.maxRequestsPerMin })}</li>
                  ) : null}
                </ul>
              ) : (
                t("budgetUnmetered")
              )}
            </dd>

            <dt className="text-muted-foreground">{t("detailCandidates")}</dt>
            <dd>
              <ol className="flex flex-col gap-0.5">
                {ticket.candidates.map((candidate, index) => (
                  <li
                    key={`${candidate.deploymentId}-${candidate.modelId}`}
                    className="truncate font-mono"
                  >
                    <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
                    {candidate.deploymentId} · {candidate.modelId}
                  </li>
                ))}
              </ol>
            </dd>

            {bindings.length > 0 ? (
              <>
                <dt className="text-muted-foreground">{t("detailBindings")}</dt>
                <dd className="flex flex-col gap-0.5">
                  {bindings.map(([selector, model]) => (
                    <span key={selector} className="truncate font-mono">
                      {selector} → {model}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}

            <dt className="text-muted-foreground">{t("detailAuthFailover")}</dt>
            <dd>{ticket.allowAuthFailover ? t("yes") : t("no")}</dd>

            <dt className="text-muted-foreground">{t("detailIssued")}</dt>
            <dd>
              <SinceTime date={new Date(ticket.issuedAtMs)} now={now} />
            </dd>

            {ticket.profileVersion != null ? (
              <>
                <dt className="text-muted-foreground">{t("detailProfileVersion")}</dt>
                <dd className="tabular-nums">{ticket.profileVersion}</dd>
              </>
            ) : null}

            <dt className="text-muted-foreground">{t("detailFingerprint")}</dt>
            <dd className="truncate font-mono">{ticket.executionFingerprint}</dd>
          </dl>
        </MotionCollapse>
      </div>
    </Item>
  )
}

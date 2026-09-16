"use client"

// The run card on an assistant message routed through Router + Fusion
// (ADR-0188 D23): a compact chip with the booked cost that expands into how
// the turn was routed and what the ledger recorded. A turn that fell back to
// the original path shows a "not ledgered" chip instead, and the verified
// answer of a cascade or panel run shows its roles and phase timeline (B3).
// The data is the plain copy the turn put on the message; nothing is loaded.

import { useTranslations } from "next-intl"
import { AlertTriangle, Route } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { RouterFusionRunMetadata } from "@/lib/chat/message-run-metadata"
import { cn } from "@/lib/utils"

import {
  formatMicrousd,
  FusionRunDetails,
  KNOWN_COST_STATUSES,
  KNOWN_PROFILES,
  KNOWN_RUN_STATUSES,
  RunDetailRow as Row,
} from "./fusion-run-details"

export { formatMicrousd }

export interface RouterFusionRunCardProps {
  routerFusion: RouterFusionRunMetadata
}

export function RouterFusionRunCard({ routerFusion }: RouterFusionRunCardProps) {
  const t = useTranslations("routerFusion.runCard")
  const tRefusal = useTranslations("routerFusion.refusal")
  const tProfile = useTranslations("routerFusion.settings.actions.profileValue")
  const { route, outcome, bypass, fusion } = routerFusion

  if (fusion) {
    const warn = Boolean(
      fusion.errorCode || fusion.timeline.degraded || fusion.qualityStatus === "degraded"
    )
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="router-fusion-run-card"
            aria-label={t("details")}
            className={cn(
              "h-5 gap-1 rounded-md px-1.5 text-[10px] font-normal",
              warn && "text-amber-600 dark:text-amber-400"
            )}
          >
            <Route className="size-3" aria-hidden />
            <span>{fusion.mode === "panel" ? t("fusion.chipPanel") : t("fusion.chipCascade")}</span>
            <span className="tabular-nums">{formatMicrousd(fusion.spentMicrousd)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 p-3 text-xs"
          data-testid="router-fusion-run-details"
        >
          <p className="mb-2 font-medium">{t("details")}</p>
          <FusionRunDetails summary={fusion} />
        </PopoverContent>
      </Popover>
    )
  }

  if (!route) {
    if (!bypass) return null
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            data-testid="router-fusion-bypass"
            className="h-5 cursor-help gap-1 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle className="size-3" aria-hidden />
            {t("notLedgered")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {bypass.justTripped
            ? t("bypassedTripped", { code: bypass.code })
            : t("bypassed", { code: bypass.code })}
        </TooltipContent>
      </Tooltip>
    )
  }

  const profileText = (profile: string) =>
    KNOWN_PROFILES.has(profile) ? tProfile(profile as never) : profile
  const refusalText = (code: string) =>
    typeof tRefusal.has === "function" && tRefusal.has(code as never)
      ? tRefusal(code as never)
      : tRefusal("unknown", { code })
  const statusText = (status: string) =>
    KNOWN_RUN_STATUSES.has(status)
      ? t(`statusValue.${status}` as never)
      : t("statusValue.unknown", { status })
  const warn = Boolean(outcome?.refusalCode || outcome?.frozen || bypass)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="router-fusion-run-card"
          aria-label={t("details")}
          className={cn(
            "h-5 gap-1 rounded-md px-1.5 text-[10px] font-normal",
            warn && "text-amber-600 dark:text-amber-400"
          )}
        >
          <Route className="size-3" aria-hidden />
          <span>{t("label")}</span>
          {outcome ? (
            <span className="tabular-nums">{formatMicrousd(outcome.spentMicrousd)}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3 text-xs"
        data-testid="router-fusion-run-details"
      >
        <p className="mb-2 font-medium">{t("details")}</p>
        <dl className="space-y-1.5">
          {outcome ? <Row label={t("status")}>{statusText(outcome.status)}</Row> : null}
          {outcome?.refusalCode ? (
            <Row label={t("refused")}>
              <span className="text-amber-600 dark:text-amber-400">
                {refusalText(outcome.refusalCode)}
              </span>
            </Row>
          ) : null}
          <Row label={t("action")}>{route.actionId}</Row>
          <Row label={t("mode")}>{t("modeDirect")}</Row>
          <Row label={t("rule")}>{route.ruleId ?? t("ruleBaseline")}</Row>
          <Row label={t("model")}>
            {route.providerId} / {route.modelId}
          </Row>
          <Row label={t("lane")}>
            {route.lane === "ai-sdk" ? t("laneAiSdk") : t("laneAgentSdk")}
          </Row>
          <Row label={t("budget")}>
            {route.budgetMode === "strict" ? t("budgetStrict") : t("budgetTracked")}
          </Row>
          <Row label={t("cap")}>{formatMicrousd(route.capMicrousd)}</Row>
          {outcome ? (
            <>
              <Row label={t("cost")}>
                <span className="tabular-nums">{formatMicrousd(outcome.spentMicrousd)}</span>{" "}
                <span className="text-muted-foreground">
                  {t("costStatusParenthesized", {
                    status: KNOWN_COST_STATUSES.has(outcome.costStatus)
                      ? t(`costStatus.${outcome.costStatus}` as never)
                      : outcome.costStatus,
                  })}
                </span>
              </Row>
              <Row label={t("calls")}>{outcome.modelCalls}</Row>
              {outcome.overspendMicrousd > 0 ? (
                <Row label="">
                  <span className="text-amber-600 dark:text-amber-400">
                    {t("overspend", { amount: formatMicrousd(outcome.overspendMicrousd) })}
                  </span>
                </Row>
              ) : null}
              {outcome.frozen ? (
                <Row label="">
                  <span className="text-amber-600 dark:text-amber-400">{t("frozen")}</span>
                </Row>
              ) : null}
            </>
          ) : null}
          {route.acceptanceProfile ? (
            <Row label={t("acceptance")}>
              {route.acceptanceProfile === "text_basic"
                ? t("acceptanceSchemaOnly", { profile: profileText(route.acceptanceProfile) })
                : profileText(route.acceptanceProfile)}
            </Row>
          ) : null}
          <Row label={t("runId")}>
            <span className="font-mono text-[10px]">{route.runId}</span>
          </Row>
        </dl>
        {!route.priceKnown ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t("estimatedCap")}</p>
        ) : null}
        {bypass ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {bypass.justTripped
              ? t("bypassedTripped", { code: bypass.code })
              : t("bypassed", { code: bypass.code })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

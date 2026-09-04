"use client"

import { RotateCcw, Server } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { formatMs } from "@/lib/provider-diagnostics/format"
import { ProviderSection } from "../provider-section"
import type { compareProviderEndpointsFree } from "@/lib/provider-diagnostics/endpoints"
import type { ProviderEndpointCandidate, ProviderEndpointChange } from "@cognia/provider-types"

type EndpointComparison = Awaited<ReturnType<typeof compareProviderEndpointsFree>>[number]

export interface EndpointsSectionProps {
  candidates: ProviderEndpointCandidate[]
  comparisons: EndpointComparison[]
  /** Endpoint currently in effect for the provider. */
  currentEndpoint: string
  customEndpoint: string
  onCustomEndpointChange: (value: string) => void
  /** Commit the typed value as a candidate (trims it). */
  onAddCustomEndpoint: () => void
  onCompareFree: () => void
  onComparePaid: () => void
  comparing: boolean
  /** A paid comparison needs a model selected in the composer. */
  comparePaidDisabled: boolean
  error: string | null
  /** Ask to switch — the parent shows a before/after diff before applying. */
  onRequestApply: (endpoint: string) => void
  /** Applied switches that can still be undone. */
  rollbacks: ProviderEndpointChange[]
  onRollback: (changeId: string) => void
  readOnly?: boolean
}

/** How many undo entries stay offered; older switches are history, not actions. */
const MAX_ROLLBACKS = 3

/**
 * Endpoint candidates for this provider (catalog, user-typed, imported from
 * ccswitch) with a free reachability comparison and one-click switching.
 *
 * "Apply" is disabled for a candidate a comparison has already proven broken —
 * a measured 401 or an unverified capability is exactly the case where a user
 * would otherwise switch the provider's endpoint to something that cannot serve
 * it, and only find out at the next chat turn.
 */
export function EndpointsSection({
  candidates,
  comparisons,
  currentEndpoint,
  customEndpoint,
  onCustomEndpointChange,
  onAddCustomEndpoint,
  onCompareFree,
  onComparePaid,
  comparing,
  comparePaidDisabled,
  error,
  onRequestApply,
  rollbacks,
  onRollback,
  readOnly = false,
}: EndpointsSectionProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <ProviderSection
      collapsible
      icon={Server}
      title={t("endpoints.title")}
      description={t("endpoints.description")}
      contentClassName="space-y-3"
      data-testid="diagnostics-endpoints"
    >
      <div className="flex gap-2">
        <Input
          value={customEndpoint}
          disabled={readOnly}
          onChange={(event) => onCustomEndpointChange(event.target.value)}
          placeholder={t("endpoints.placeholder")}
        />
        <Button variant="outline" disabled={readOnly} onClick={onAddCustomEndpoint}>
          {t("endpoints.add")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 @sm/diagnostics:grid-cols-2">
        <Button
          variant="outline"
          onClick={onCompareFree}
          disabled={readOnly || comparing || candidates.length === 0}
        >
          {comparing && <Spinner className="mr-1 h-3.5 w-3.5" />}
          {t("endpoints.compareFree")}
        </Button>
        <Button
          variant="outline"
          onClick={onComparePaid}
          disabled={readOnly || comparePaidDisabled || candidates.length === 0}
        >
          {t("endpoints.comparePaid")}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="space-y-2">
        {candidates.map((candidate) => {
          const comparison = comparisons.find((row) => row.endpoint === candidate.url)
          const provenBroken = comparison
            ? !comparison.probe.capabilityVerified || comparison.probe.authenticated === false
            : false
          return (
            <div
              key={candidate.id}
              className="flex items-center justify-between gap-2 rounded-lg border p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{candidate.url}</p>
                <p className="text-[10px] text-muted-foreground">
                  {t(`endpoints.source.${candidate.source}` as never)}
                  {comparison ? ` · ${formatMs(comparison.probe.durationMs)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {comparison?.recommended && <Badge>{t("endpoints.recommended")}</Badge>}
                {candidate.url === currentEndpoint ? (
                  <Badge variant="secondary">{t("endpoints.current")}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || provenBroken}
                    onClick={() => onRequestApply(candidate.url)}
                  >
                    {t("endpoints.apply")}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {rollbacks.slice(0, MAX_ROLLBACKS).map((change) => (
        <Button
          key={change.id}
          variant="ghost"
          size="sm"
          disabled={readOnly}
          className="w-full justify-start"
          onClick={() => onRollback(change.id)}
        >
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          <span className="truncate">
            {t("endpoints.rollback", { endpoint: change.previousEndpoint })}
          </span>
        </Button>
      ))}
    </ProviderSection>
  )
}

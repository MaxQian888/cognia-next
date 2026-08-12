"use client"

import { HistoryIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { RunRetrospectiveBundle } from "@/types/execution/retrospective"

export interface RunRetrospectiveViewProps {
  bundles: RunRetrospectiveBundle[]
  canGenerate?: boolean
  busyProposalId?: string | null
  onGenerate?: () => void
  onApprove?: (proposalId: string) => void
  onReject?: (proposalId: string) => void
  onRetry?: (proposalId: string) => void
}

export function RunRetrospectiveView({
  bundles,
  canGenerate = false,
  busyProposalId,
  onGenerate,
  onApprove,
  onReject,
  onRetry,
}: RunRetrospectiveViewProps) {
  const t = useTranslations("contextWorkbench.runContext.review")

  return (
    <div className="space-y-3 p-3" data-testid="run-retrospective-view">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        {canGenerate && onGenerate ? (
          <Button type="button" size="sm" variant="outline" onClick={onGenerate}>
            {t("generate")}
          </Button>
        ) : null}
      </div>

      {bundles.length === 0 ? (
        <Empty className="min-h-48 border">
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
        </Empty>
      ) : (
        bundles.map(({ retrospective, proposals }) => (
          <section key={retrospective.id} className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                {retrospective.runId}
              </span>
              <Badge variant="outline">{t(`status.${retrospective.status}`)}</Badge>
            </div>
            {retrospective.issueTimeline.length > 0 ? (
              <ol className="space-y-1 border-l pl-3 text-xs text-muted-foreground">
                {retrospective.issueTimeline.map((item, index) => (
                  <li key={`${item.at}:${index}`}>{item.summary}</li>
                ))}
              </ol>
            ) : null}
            {proposals.map((proposal) => {
              const busy = busyProposalId === proposal.id
              return (
                <article key={proposal.id} className="space-y-2 rounded-md bg-muted/30 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{proposal.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t(`target.${proposal.targetKind}`)}
                      </p>
                    </div>
                    <Badge
                      variant={proposal.status === "apply_failed" ? "destructive" : "secondary"}
                    >
                      {t(`proposalStatus.${proposal.status}`)}
                    </Badge>
                  </div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {proposal.after}
                  </pre>
                  {proposal.applyError ? (
                    <p className="text-xs text-destructive">{proposal.applyError}</p>
                  ) : null}
                  {proposal.status === "pending" ? (
                    <div className="flex gap-2">
                      {proposal.targetKind !== "observation" && onApprove ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy}
                          onClick={() => onApprove(proposal.id)}
                        >
                          {t("approve")}
                        </Button>
                      ) : null}
                      {onReject ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => onReject(proposal.id)}
                        >
                          {proposal.targetKind === "observation" ? t("dismiss") : t("reject")}
                        </Button>
                      ) : null}
                    </div>
                  ) : proposal.status === "apply_failed" && onRetry ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRetry(proposal.id)}
                    >
                      {t("retry")}
                    </Button>
                  ) : null}
                </article>
              )
            })}
          </section>
        ))
      )}
    </div>
  )
}

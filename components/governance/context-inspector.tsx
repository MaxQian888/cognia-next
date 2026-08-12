"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  getDecisionContext,
  listDecisionContextsByCorrelation,
  listRecentGovernanceAuditGaps,
  listRecentDecisions,
  type DecisionContextView,
  type GovernanceProvenanceRow,
} from "@/lib/db/governance-ledger"

interface ContextInspectorData {
  contexts: DecisionContextView[]
  auditGaps: GovernanceProvenanceRow[]
}

const EMPTY_INSPECTOR_DATA: ContextInspectorData = { contexts: [], auditGaps: [] }

async function loadContextInspectorData(): Promise<ContextInspectorData> {
  const decisions = await listRecentDecisions(25)
  const correlated = await Promise.all(
    decisions.map((decision) =>
      listDecisionContextsByCorrelation({
        runId: decision.correlation.runId,
        sessionId: decision.correlation.sessionId,
      })
    )
  )
  const unique = new Map(
    [...decisions, ...correlated.flat()].map((decision) => [decision.id, decision])
  )
  const contexts = await Promise.all(
    [...unique.values()].map((decision) => getDecisionContext(decision.id))
  )
  return {
    contexts: contexts.filter((context): context is DecisionContextView => context !== undefined),
    auditGaps: await listRecentGovernanceAuditGaps(25),
  }
}

export function ContextInspector() {
  const t = useTranslations("settings.security.contextInspector")
  const { contexts, auditGaps } = useLiveQuery(loadContextInspectorData, [], EMPTY_INSPECTOR_DATA)
  const [selectedId, setSelectedId] = useState<string>()
  const selected = contexts.find((context) => context.decision.id === selectedId) ?? contexts[0]

  if (contexts.length === 0) {
    return (
      <div className="space-y-2">
        {auditGaps.length > 0 && (
          <p className="text-sm text-destructive" role="status">
            {t("auditGap")} <Badge variant="destructive">{auditGaps.length}</Badge>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {auditGaps.length > 0 && (
        <p className="text-sm text-destructive" role="status">
          {t("auditGap")} <Badge variant="destructive">{auditGaps.length}</Badge>
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <ScrollArea className="h-72 rounded-md border" aria-label={t("decisionListLabel")}>
          <div className="space-y-1 p-2">
            {contexts.map(({ decision }) => (
              <Button
                key={decision.id}
                type="button"
                variant={selected?.decision.id === decision.id ? "secondary" : "ghost"}
                className="h-auto w-full justify-start px-3 py-2 text-left"
                onClick={() => setSelectedId(decision.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{decision.kind}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {decision.resolution?.outcome ?? decision.question.code}
                  </span>
                </span>
                <Badge variant="outline">{decision.lifecycle.state}</Badge>
              </Button>
            ))}
          </div>
        </ScrollArea>

        {selected && (
          <div className="space-y-3 rounded-md border p-3" data-testid="context-inspector-detail">
            <div>
              <p className="text-sm font-medium">{t("whyTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {selected.decision.resolution?.rationale ??
                  selected.decision.resolution?.reasonCode ??
                  selected.decision.question.code}
              </p>
            </div>
            <Separator />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <dt className="text-muted-foreground">{t("outcome")}</dt>
              <dd className="break-all text-right">
                {selected.decision.resolution?.outcome ?? t("none")}
              </dd>
              <dt className="text-muted-foreground">{t("evidence")}</dt>
              <dd className="text-right">{selected.evidence.length}</dd>
              <dt className="text-muted-foreground">{t("events")}</dt>
              <dd className="text-right">{selected.events.length}</dd>
              <dt className="text-muted-foreground">{t("lineage")}</dt>
              <dd className="text-right">{selected.lineage.length}</dd>
              <dt className="text-muted-foreground">{t("provenance")}</dt>
              <dd className="text-right">{selected.provenance.length}</dd>
              <dt className="text-muted-foreground">{t("conflicts")}</dt>
              <dd className="text-right">
                {selected.conflicts.length}
                {selected.conflicts.some((conflict) => conflict.status === "open") && (
                  <Badge variant="destructive" className="ml-2">
                    {t("open")}
                  </Badge>
                )}
              </dd>
            </dl>
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              {selected.decision.id}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

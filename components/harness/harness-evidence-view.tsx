"use client"

/**
 * One rollout's Execution Evidence: what it delivered, which checks passed,
 * what it cost, what the probe policy blocked, and the full trajectory.
 */

import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import type { HarnessExecutionEvidence } from "@/types/harness/evolution"

function Pre({ children, testId }: { children: string; testId?: string }) {
  return (
    <pre
      className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-xs"
      data-testid={testId}
    >
      {children}
    </pre>
  )
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex flex-col gap-1.5">
      <CollapsibleTrigger className="group flex items-center gap-1 text-left text-xs font-medium">
        <ChevronDownIcon
          className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function HarnessEvidenceView({ evidence }: { evidence: HarnessExecutionEvidence }) {
  const t = useTranslations("harnessEvolution.evidence")
  const m = evidence.metrics
  return (
    <div className="flex flex-col gap-3" data-testid="harness-evidence">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={evidence.delivered ? "success" : "destructive"}>
          {evidence.delivered ? t("delivered") : t("notDelivered")}
        </Badge>
        {evidence.degraded ? <Badge variant="warning">{t("degraded")}</Badge> : null}
        {evidence.error ? <Badge variant="destructive">{t("errored")}</Badge> : null}
      </div>
      {evidence.error ? <p className="text-sm text-destructive">{evidence.error}</p> : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        {(
          [
            ["tokens", `${formatTokens(m.inputTokens)} / ${formatTokens(m.outputTokens)}`],
            ["cost", m.costUsd === undefined ? t("unpriced") : formatUsd(m.costUsd)],
            ["latency", formatMs(m.latencyMs)],
            ["tools", t("toolCalls", { calls: m.toolCalls, failures: m.toolFailures })],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-muted-foreground">{t(`metric.${key}`)}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {evidence.validation.length ? (
        <div className="flex flex-col gap-1">
          <h5 className="text-xs font-medium">{t("checks")}</h5>
          <ul className="flex flex-col gap-1 text-xs" data-testid="harness-evidence-checks">
            {evidence.validation.map((v, i) => (
              <li key={`${v.check}-${i}`} className="flex items-start gap-2">
                <Badge
                  variant={
                    v.status === "passed"
                      ? "success"
                      : v.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {t(`checkStatus.${v.status}`)}
                </Badge>
                <span className="min-w-0 break-words">
                  <code>{v.check}</code>
                  {v.detail ? <span className="text-muted-foreground"> — {v.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evidence.blockedActions.length ? (
        <div className="flex flex-col gap-1">
          <h5 className="text-xs font-medium">{t("blocked")}</h5>
          <ul className="flex flex-col gap-0.5 text-xs">
            {evidence.blockedActions.map((b, i) => (
              <li key={`${b.toolName}-${i}`}>
                <code>{b.toolName}</code> <span className="text-muted-foreground">{b.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evidence.caveats?.length ? (
        <ul
          className="list-disc pl-4 text-xs text-muted-foreground"
          data-testid="harness-evidence-caveats"
        >
          {evidence.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}

      {evidence.delegations.length ? (
        <p className="text-xs text-muted-foreground">
          {t("delegations", { list: evidence.delegations.join(", ") })}
        </p>
      ) : null}
      {evidence.externalReads?.length ? (
        <p className="text-xs text-muted-foreground" data-testid="harness-evidence-external">
          {t("externalReads", { list: evidence.externalReads.join(", ") })}
        </p>
      ) : null}

      <Section title={t("output")} defaultOpen>
        <Pre testId="harness-evidence-output">{evidence.output || t("emptyOutput")}</Pre>
      </Section>
      {evidence.deliverables.length ? (
        <Section title={t("deliverables", { count: evidence.deliverables.length })}>
          <div className="flex flex-col gap-2">
            {evidence.deliverables.map((d) => (
              <div key={d.path} className="flex flex-col gap-1">
                <code className="text-xs">
                  {d.path} · {t("bytes", { bytes: d.bytes })}
                  {d.truncated ? ` · ${t("truncated")}` : ""}
                </code>
                {d.text !== undefined ? <Pre>{d.text}</Pre> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title={t("trajectory")}>
        <Pre testId="harness-evidence-trajectory">{evidence.trajectory || t("emptyOutput")}</Pre>
      </Section>
    </div>
  )
}

"use client"

import { ArrowDownUp, CheckCircle2, Gauge, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCostUsd, formatMs, formatNumber } from "@/lib/provider-diagnostics/format"
import { ProviderSection } from "../provider-section"
import type {
  ProviderDiagnosticFilters,
  ProviderDiagnosticMatrixRow,
  ProviderDiagnosticScenario,
} from "@/lib/provider-diagnostics/analysis"

export interface MatrixSectionProps {
  rows: ProviderDiagnosticMatrixRow[]
  scenario: ProviderDiagnosticScenario
  onScenarioChange: (scenario: ProviderDiagnosticScenario) => void
  filters: ProviderDiagnosticFilters
  onFiltersChange: (filters: ProviderDiagnosticFilters) => void
  /** Distinct values present in the data, per filter axis. */
  options: { models: string[]; credentials: string[]; endpoints: string[] }
}

/**
 * The comparison matrix: one row per diagnostic target, ranked for the chosen
 * scenario, with the winner called out above it.
 *
 * Renders as a table on a wide pane and as cards below `@3xl` — an eight-column
 * table inside the ~430px detail pane was unreadable, and horizontal scrolling
 * a metrics table means you can never see the model name and its cost at once.
 */
export function MatrixSection({
  rows,
  scenario,
  onScenarioChange,
  filters,
  onFiltersChange,
  options,
}: MatrixSectionProps) {
  const t = useTranslations("providers.diagnostics")
  const patch = (next: Partial<ProviderDiagnosticFilters>) =>
    onFiltersChange({ ...filters, ...next })

  return (
    <ProviderSection
      icon={ArrowDownUp}
      title={t("matrix.title")}
      description={t("matrix.description")}
      data-testid="diagnostics-matrix"
      actions={
        <Select
          value={filters.status}
          onValueChange={(value) => patch({ status: value as ProviderDiagnosticFilters["status"] })}
        >
          <SelectTrigger className="w-32" aria-label={t("matrix.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.all")}</SelectItem>
            <SelectItem value="completed">{t("status.completed")}</SelectItem>
            <SelectItem value="failed">{t("status.failed")}</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      <div className="mb-4 grid gap-2 @md/diagnostics:grid-cols-2 @4xl/diagnostics:grid-cols-3">
        <Select
          value={scenario}
          onValueChange={(value) => onScenarioChange(value as ProviderDiagnosticScenario)}
        >
          <SelectTrigger aria-label={t("filters.scenario")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="interactive">{t("filters.interactive")}</SelectItem>
            <SelectItem value="batch">{t("filters.batch")}</SelectItem>
            <SelectItem value="economy">{t("filters.economy")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.modelId} onValueChange={(value) => patch({ modelId: value })}>
          <SelectTrigger aria-label={t("filters.model")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allModels")}</SelectItem>
            {options.models.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.capability} onValueChange={(value) => patch({ capability: value })}>
          <SelectTrigger aria-label={t("filters.capability")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allCapabilities")}</SelectItem>
            <SelectItem value="probe">{t("composer.probe")}</SelectItem>
            <SelectItem value="text-generation">{t("composer.text")}</SelectItem>
            <SelectItem value="embedding">{t("composer.embedding")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.credentialFingerprint}
          onValueChange={(value) => patch({ credentialFingerprint: value })}
        >
          <SelectTrigger aria-label={t("filters.credential")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allCredentials")}</SelectItem>
            {options.credentials.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.endpoint} onValueChange={(value) => patch({ endpoint: value })}>
          <SelectTrigger aria-label={t("filters.endpoint")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filters.allEndpoints")}</SelectItem>
            {options.endpoints.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.range}
          onValueChange={(value) => patch({ range: value as ProviderDiagnosticFilters["range"] })}
        >
          <SelectTrigger aria-label={t("filters.date")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">{t("filters.last24h")}</SelectItem>
            <SelectItem value="7d">{t("filters.last7d")}</SelectItem>
            <SelectItem value="all">{t("filters.allDates")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {rows.length > 0 && (
        <Alert className="mb-4">
          <Gauge className="h-4 w-4" />
          <AlertTitle>{t("matrix.recommendation")}</AlertTitle>
          <AlertDescription>
            {t(`matrix.reason.${scenario}`, {
              model: rows[0].sample?.modelId ?? t("composer.probe"),
            })}
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Gauge className="mx-auto mb-2 h-8 w-8 opacity-30" />
          {t("matrix.empty")}
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto @3xl/diagnostics:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("matrix.model")}</TableHead>
                  <TableHead>{t("matrix.endpoint")}</TableHead>
                  <TableHead>{t("matrix.status")}</TableHead>
                  <TableHead>{t("matrix.ttft")}</TableHead>
                  <TableHead>{t("matrix.total")}</TableHead>
                  <TableHead>{t("matrix.throughput")}</TableHead>
                  <TableHead>{t("matrix.cost")}</TableHead>
                  <TableHead>{t("matrix.samples")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ targetId, sample, summary }) => (
                  <TableRow key={targetId}>
                    <TableCell className="font-medium">
                      {sample?.modelId ?? t("composer.probe")}
                    </TableCell>
                    <TableCell className="max-w-48 truncate" title={sample?.endpoint}>
                      {sample?.endpoint}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sample?.status === "completed" ? "default" : "destructive"}>
                        {sample?.status === "completed"
                          ? t("status.completed")
                          : t("status.failed")}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatMs(summary.ttftMs?.median)}</TableCell>
                    <TableCell>{formatMs(summary.totalDurationMs?.median)}</TableCell>
                    <TableCell>{formatNumber(summary.outputTokensPerSecond?.median)}</TableCell>
                    <TableCell>{formatCostUsd(summary.estimatedCostUsd?.median)}</TableCell>
                    <TableCell>
                      {summary.measuredSamples}
                      {summary.totalDurationMs?.p95 === undefined
                        ? ""
                        : ` · P95 ${formatMs(summary.totalDurationMs.p95)}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-3 @3xl/diagnostics:hidden">
            {rows.map(({ targetId, sample, summary }) => (
              <article key={targetId} className="rounded-lg border p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-medium">
                      {sample?.modelId ?? t("composer.probe")}
                    </h4>
                    <p className="truncate text-xs text-muted-foreground">{sample?.endpoint}</p>
                  </div>
                  {sample?.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t("matrix.ttft")}</dt>
                    <dd>{formatMs(summary.ttftMs?.median)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("matrix.throughput")}</dt>
                    <dd>{formatNumber(summary.outputTokensPerSecond?.median)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("matrix.total")}</dt>
                    <dd>{formatMs(summary.totalDurationMs?.median)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("matrix.samples")}</dt>
                    <dd>{summary.measuredSamples}</dd>
                  </div>
                </dl>
                {sample?.failure && (
                  <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
                    {sample.failure.message}
                  </p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </ProviderSection>
  )
}

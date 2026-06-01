"use client"

/**
 * Trace analysis panel — the "look at your data" flywheel. Lists recent real
 * traces, lets the user open-code the first failure + a cluster label, rolls
 * the labels up into a failure taxonomy with a saturation cue, and promotes a
 * trace into an {@link EvalCase} in a chosen dataset.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { MicroscopeIcon, SaveIcon, FilePlus2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { useEvalDatasets, useRecentTraces, useTraceAnnotations } from "@/hooks/eval/use-eval-data"
import { upsertAnnotation, markSavedAsCase } from "@/lib/db/trace-annotations"
import { addCase } from "@/lib/db/eval-datasets"
import { buildFailureTaxonomy, saturationReached } from "@/lib/ai/eval/error-analysis/coding"
import type { TraceSummary } from "@/lib/ai/eval/trace-summary"
import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"

function TraceRow({
  trace,
  annotation,
  datasetId,
}: {
  trace: TraceSummary
  annotation?: TraceAnnotationRow
  datasetId?: string
}) {
  const t = useTranslations("eval")
  const [note, setNote] = useState(annotation?.firstFailureNote ?? "")
  const [mode, setMode] = useState(annotation?.failureMode ?? "")
  const [savedCase, setSavedCase] = useState(Boolean(annotation?.savedAsCaseId))

  const handleSave = useCallback(async () => {
    await upsertAnnotation({
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      firstFailureNote: note,
      ...(mode.trim() ? { failureMode: mode.trim() } : {}),
    })
  }, [trace.traceId, trace.sessionId, note, mode])

  const handleSaveAsCase = useCallback(async () => {
    if (!datasetId) return
    const created = await addCase(datasetId, {
      input: trace.preview || trace.traceId,
      source: "real-trace",
      sourceTraceId: trace.traceId,
      ...(mode.trim() ? { failureMode: mode.trim() } : {}),
    })
    await markSavedAsCase(trace.traceId, created.id)
    setSavedCase(true)
  }, [datasetId, trace.preview, trace.traceId, mode])

  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="trace-row">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("annotate.session", { id: trace.sessionId })}</span>
        <span className="flex flex-wrap gap-1">
          {trace.toolNames.map((name, i) => (
            <Badge key={`${name}-${i}`} variant="outline" className="text-[10px]">
              {name}
            </Badge>
          ))}
        </span>
      </div>
      {trace.preview && <p className="line-clamp-2 text-sm">{trace.preview}</p>}
      <Textarea
        aria-label={t("annotate.firstFailure")}
        placeholder={t("annotate.firstFailurePlaceholder")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <Input
        aria-label={t("annotate.failureMode")}
        placeholder={t("annotate.failureModePlaceholder")}
        value={mode}
        onChange={(e) => setMode(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleSave}>
          <SaveIcon className="size-4" />
          {t("annotate.save")}
        </Button>
        <Button size="sm" disabled={!datasetId || savedCase} onClick={handleSaveAsCase}>
          <FilePlus2Icon className="size-4" />
          {savedCase ? t("annotate.savedAsCase") : t("annotate.saveAsCase")}
        </Button>
      </div>
    </Card>
  )
}

export function TraceAnnotationPanel() {
  const t = useTranslations("eval")
  const traces = useRecentTraces()
  const annotations = useTraceAnnotations()
  const datasets = useEvalDatasets()
  const [datasetId, setDatasetId] = useState<string | undefined>(undefined)

  const annotationByTrace = useMemo(() => {
    const map = new Map<string, TraceAnnotationRow>()
    for (const a of annotations) map.set(a.traceId, a)
    return map
  }, [annotations])

  const taxonomy = useMemo(() => buildFailureTaxonomy(annotations), [annotations])
  const saturated = useMemo(() => saturationReached(annotations), [annotations])
  const effectiveDataset = datasetId ?? datasets[0]?.id

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <MicroscopeIcon className="size-5" />
        <div>
          <h1 className="text-lg font-semibold">{t("annotate.heading")}</h1>
          <p className="text-muted-foreground text-sm">{t("annotate.subtitle")}</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          {t("annotate.pickDataset")}{" "}
          <select
            aria-label={t("annotate.pickDataset")}
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={effectiveDataset ?? ""}
            onChange={(e) => setDatasetId(e.target.value || undefined)}
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {taxonomy.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-xs">{t("annotate.taxonomy")}:</span>
            {taxonomy.map((c) => (
              <Badge key={c.failureMode} variant="secondary" className="text-xs">
                {c.failureMode} · {c.count}
              </Badge>
            ))}
          </div>
        )}
        {saturated && (
          <span className="text-xs text-emerald-600" role="status">
            {t("annotate.saturation")}
          </span>
        )}
      </div>

      {traces.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("annotate.empty")}</p>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {traces.map((trace) => (
            <TraceRow
              key={trace.traceId}
              trace={trace}
              annotation={annotationByTrace.get(trace.traceId)}
              datasetId={effectiveDataset}
            />
          ))}
        </div>
      )}
    </div>
  )
}

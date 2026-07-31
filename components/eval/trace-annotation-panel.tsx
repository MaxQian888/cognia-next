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
import {
  useEvalDatasets,
  useRecentTraces,
  useTraceAnnotations,
  useTraceCount,
  useTracePrompts,
} from "@/hooks/eval/use-eval-data"
import { upsertAnnotation, markSavedAsCase } from "@/lib/db/trace-annotations"
import { addCase } from "@/lib/db/eval-datasets"
import { buildFailureTaxonomy, saturationReached } from "@/lib/ai/eval/error-analysis/coding"
import type { TraceSummary } from "@/lib/ai/eval/trace-summary"
import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"

/** Traces per page. The list is one card per trace, so keep it scannable. */
const PAGE_SIZE = 25

interface DraftEdits {
  note: string
  mode: string
}

function TraceRow({
  trace,
  annotation,
  datasetId,
  draft,
  prompt,
  onEdit,
}: {
  trace: TraceSummary
  annotation?: TraceAnnotationRow
  datasetId?: string
  /** Unsaved edits, or `undefined` when the row is showing what is persisted. */
  draft?: DraftEdits
  /** The ORIGINAL user prompt, when it could be recovered from the session. */
  prompt?: string
  onEdit: (traceId: string, next: DraftEdits) => void
}) {
  const t = useTranslations("eval")
  // DERIVED, not seeded into local state. `useRecentTraces` and
  // `useTraceAnnotations` are independent async live queries: when the traces
  // resolved first the rows mounted with empty fields, the annotations arrived
  // afterwards and never reached them, so a previously saved note rendered
  // blank — and pressing Save then overwrote it with "".
  const note = draft?.note ?? annotation?.firstFailureNote ?? ""
  const mode = draft?.mode ?? annotation?.failureMode ?? ""
  const setNote = (v: string) => onEdit(trace.traceId, { note: v, mode })
  const setMode = (v: string) => onEdit(trace.traceId, { note, mode: v })
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
    // The ORIGINAL prompt, not `trace.preview` — the preview is a truncated,
    // PII-gated span field, so cases promoted from real traffic used to carry
    // a clipped fragment of what the user actually asked.
    const created = await addCase(datasetId, {
      input: prompt || trace.preview || trace.traceId,
      source: "real-trace",
      sourceTraceId: trace.traceId,
      ...(mode.trim() ? { failureMode: mode.trim() } : {}),
    })
    await markSavedAsCase(trace.traceId, created.id)
    setSavedCase(true)
  }, [datasetId, prompt, trace.preview, trace.traceId, mode])

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
      {(prompt || trace.preview) && (
        <p className="line-clamp-2 text-sm" data-testid="trace-prompt">
          {prompt || trace.preview}
        </p>
      )}
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
  const [page, setPage] = useState(0)
  const traces = useRecentTraces(PAGE_SIZE, page * PAGE_SIZE)
  const traceCount = useTraceCount()
  const prompts = useTracePrompts(traces)
  const annotations = useTraceAnnotations()
  const datasets = useEvalDatasets()
  const [datasetId, setDatasetId] = useState<string | undefined>(undefined)
  /** Per-trace unsaved edits. Absent key = the row mirrors what is persisted. */
  const [drafts, setDrafts] = useState<Record<string, DraftEdits>>({})
  const handleEdit = useCallback(
    (traceId: string, next: DraftEdits) => setDrafts((cur) => ({ ...cur, [traceId]: next })),
    []
  )

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
          <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
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
              {...(drafts[trace.traceId] ? { draft: drafts[trace.traceId] } : {})}
              {...(prompts[trace.traceId] ? { prompt: prompts[trace.traceId] } : {})}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {traceCount > PAGE_SIZE && (
        <div className="flex items-center gap-2 text-xs" data-testid="trace-pager">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t("annotate.prevPage")}
          </Button>
          <span className="text-muted-foreground tabular-nums">
            {t("annotate.pageOf", {
              page: page + 1,
              pages: Math.ceil(traceCount / PAGE_SIZE),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={(page + 1) * PAGE_SIZE >= traceCount}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("annotate.nextPage")}
          </Button>
        </div>
      )}
    </div>
  )
}

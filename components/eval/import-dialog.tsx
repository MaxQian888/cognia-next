"use client"

/**
 * Dataset import wizard: pick a source → map its columns → preview → import.
 *
 * Four sources feed one pipeline:
 *   • File        — CSV / JSON / JSONL / YAML
 *   • HuggingFace — datasets-server, with real config/split/column discovery
 *   • History     — bulk-promote the app's own recent traces
 *   • Foreign     — promptfoo / OpenAI-Evals / LangSmith exports
 *
 * Three things this used to get wrong, all of which made importing a real test
 * set fail quietly:
 *
 *  - **The HF tab had no mapping UI** and hardcoded `{input:"question",
 *    expected:"answer"}`. Any dataset not using those two column names imported
 *    zero rows and reported success. It now discovers configs, splits and
 *    columns up front and offers the same mapping controls as the File tab.
 *  - **HF and Foreign imported on click**, straight to Dexie, with no preview
 *    and no undo, while the File tab previewed first. Every source now stops at
 *    a preview.
 *  - **Writes went through `addCase` one at a time** — four Dexie round-trips
 *    and a dataset-version bump per case, so a 1300-case import was thousands
 *    of serial operations with no progress and no way out. It now goes through
 *    `bulkAddCases`: chunked transactions, one version bump, progress, cancel,
 *    and idempotent upsert by source id so a re-import converges rather than
 *    doubling the dataset.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { bulkAddCases, updateDataset } from "@/lib/db/eval-datasets"
import {
  parseCsv,
  parseStructured,
  mapRowsToCases,
  importForeign,
  importHuggingFace,
  fetchHuggingFaceSchema,
  tracesToCases,
  type MappingDeps,
} from "@/lib/ai/eval/import"
import { useRecentTraces, useTracePrompts } from "@/hooks/eval/use-eval-data"
import type {
  FieldSpec,
  ForeignFormat,
  ImportFormat,
  ImportPreview,
  ParsedRows,
} from "@/types/eval/import"
import type { GradingSpec } from "@/types/eval/grading"
import type { EvalCase } from "@/types/eval/eval"
import { GradingEditor } from "./grading-editor"

type SourceTab = "file" | "huggingface" | "history" | "foreign"

/** Upper bound on one import. Larger benchmarks are imported split-by-split. */
const MAX_IMPORT_ROWS = 5000

function detectFormat(filename: string): ImportFormat {
  const ext = filename.toLowerCase().split(".").pop()
  if (ext === "csv") return "csv"
  if (ext === "jsonl" || ext === "ndjson") return "jsonl"
  if (ext === "yaml" || ext === "yml") return "yaml"
  return "json"
}

let importSeq = 0
function makeDeps(datasetId: string, capability: string): MappingDeps {
  return {
    datasetId,
    capability,
    now: () => Date.now(),
    id: () => `evc_imp_${Date.now().toString(36)}_${(importSeq++).toString(36)}`,
  }
}

/**
 * Live online state. `navigator.onLine` was read once at render, so a dialog
 * opened offline stayed disabled after the network came back (and vice versa).
 */
const subscribeOnline = (onChange: () => void) => {
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  return () => {
    window.removeEventListener("online", onChange)
    window.removeEventListener("offline", onChange)
  }
}
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  )
}

export interface ImportDialogProps {
  datasetId: string
  capability: string
  /** Grading rule to pre-select, from the dataset's last import. */
  defaultGrading?: GradingSpec
  onClose: () => void
}

export function ImportDialog({
  datasetId,
  capability,
  defaultGrading,
  onClose,
}: ImportDialogProps) {
  const t = useTranslations("eval")
  const online = useOnline()
  const [tab, setTab] = useState<SourceTab>("file")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ added: number; updated: number } | null>(null)

  // ── Column-mapped sources (file + HuggingFace) share one parsed-rows state ──
  const [parsed, setParsed] = useState<ParsedRows | null>(null)
  const [inputCol, setInputCol] = useState("")
  const [expectedCol, setExpectedCol] = useState("")
  const [idCol, setIdCol] = useState("")
  const [splitCol, setSplitCol] = useState("")
  const [splitLiteral, setSplitLiteral] = useState("")
  const [grading, setGrading] = useState<GradingSpec>(defaultGrading ?? { mode: "exact" })
  const [useGrading, setUseGrading] = useState(true)

  // ── HuggingFace discovery ──
  const [hfUri, setHfUri] = useState("")
  const [hfSplits, setHfSplits] = useState<{ config: string; split: string }[]>([])
  /** Index into {@link hfSplits} — avoids packing config+split into one string. */
  const [hfChoiceIdx, setHfChoiceIdx] = useState(0)
  const [hfLimit, setHfLimit] = useState(200)
  const [probing, setProbing] = useState(false)

  // ── Sources that produce cases directly ──
  const [directCases, setDirectCases] = useState<EvalCase[] | null>(null)
  const [foreignFormat, setForeignFormat] = useState<ForeignFormat>("promptfoo")
  const traces = useRecentTraces(50)
  const tracePrompts = useTracePrompts(traces)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  // ── Import execution ──
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [controller, setController] = useState<AbortController | null>(null)

  const reset = useCallback(() => {
    setError(null)
    setDone(null)
  }, [])
  /** Drop whatever source is staged. Stable, so the source loaders can depend on it. */
  const clearSource = useCallback(() => {
    reset()
    setParsed(null)
    setDirectCases(null)
    setProgress(null)
  }, [reset])

  const spec = useMemo<FieldSpec | null>(() => {
    if (!inputCol) return null
    return {
      input: inputCol,
      ...(expectedCol ? { expected: expectedCol } : {}),
      ...(idCol ? { id: idCol } : {}),
      ...(splitCol ? { split: splitCol } : {}),
      ...(splitLiteral.trim() ? { splitLiteral: splitLiteral.trim() } : {}),
      ...(useGrading && expectedCol ? { grading } : {}),
    }
  }, [inputCol, expectedCol, idCol, splitCol, splitLiteral, useGrading, grading])

  const preview = useMemo<ImportPreview | null>(() => {
    if (directCases) return { cases: directCases, skipped: [] }
    if (!parsed || !spec) return null
    return mapRowsToCases(parsed, spec, makeDeps(datasetId, capability))
  }, [directCases, parsed, spec, datasetId, capability])

  /** A real golden answer from the source, for the grading extraction preview. */
  const sampleExpected = useMemo(() => {
    if (!parsed || !expectedCol) return undefined
    const raw = parsed.rows[0]?.[expectedCol]
    return typeof raw === "string" ? raw : raw === undefined ? undefined : JSON.stringify(raw)
  }, [parsed, expectedCol])

  const acceptRows = useCallback((rows: ParsedRows, literalSplit?: string) => {
    setParsed(rows)
    setDirectCases(null)
    setInputCol(rows.columns[0] ?? "")
    setExpectedCol(rows.columns[1] ?? "")
    setIdCol("")
    setSplitCol("")
    setSplitLiteral(literalSplit ?? "")
  }, [])

  const onFile = useCallback(
    async (file: File) => {
      clearSource()
      try {
        const text = await file.text()
        const fmt = detectFormat(file.name)
        acceptRows(fmt === "csv" ? parseCsv(text) : parseStructured(text, fmt))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [acceptRows, clearSource]
  )

  const probeHf = useCallback(async () => {
    clearSource()
    setProbing(true)
    try {
      const schema = await fetchHuggingFaceSchema(hfUri)
      setHfSplits(schema.splits)
      const idx = schema.splits.findIndex(
        (s) => s.config === schema.ref.config && s.split === schema.ref.split
      )
      setHfChoiceIdx(idx >= 0 ? idx : 0)
      acceptRows({ columns: schema.columns, rows: schema.sampleRows }, schema.ref.split)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }, [hfUri, acceptRows, clearSource])

  const importForeignFile = useCallback(
    async (file: File) => {
      clearSource()
      try {
        const text = await file.text()
        const raw: unknown =
          foreignFormat === "openai-evals" ? parseStructured(text, "jsonl").rows : JSON.parse(text)
        setDirectCases(importForeign(foreignFormat, raw, makeDeps(datasetId, capability)).cases)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [foreignFormat, datasetId, capability, clearSource]
  )

  const stageHistory = useCallback(() => {
    clearSource()
    setDirectCases(
      tracesToCases(
        traces,
        makeDeps(datasetId, capability),
        { traceIds: [...picked] },
        // The original prompts, not the truncated previews.
        { prompts: tracePrompts }
      ).cases
    )
  }, [traces, tracePrompts, picked, datasetId, capability, clearSource])

  /**
   * Persist the staged preview. HuggingFace re-fetches at full `hfLimit` here
   * rather than at probe time — probing pulls five rows to show columns, and
   * downloading a thousand just to render a mapping form would be rude.
   */
  const runImport = useCallback(async () => {
    if (!preview || !spec) {
      if (!directCases) return
    }
    reset()
    setBusy(true)
    const ac = new AbortController()
    setController(ac)
    try {
      let cases = preview?.cases ?? []
      if (tab === "huggingface" && spec) {
        setProgress({ done: 0, total: hfLimit })
        const full = await importHuggingFace(
          hfUriForChoice(hfUri, hfSplits[hfChoiceIdx]),
          spec,
          makeDeps(datasetId, capability),
          {
            limit: Math.min(MAX_IMPORT_ROWS, hfLimit),
            signal: ac.signal,
            onProgress: (fetched, total) =>
              setProgress({ done: fetched, total: Math.min(total ?? hfLimit, hfLimit) }),
          }
        )
        cases = full.cases
      }
      if (cases.length === 0) {
        setError(t("import.nothingToImport"))
        return
      }
      setProgress({ done: 0, total: cases.length })
      const result = await bulkAddCases(
        datasetId,
        cases.map((c) => ({
          id: c.id,
          input: c.input,
          source: c.source,
          ...(c.reference ? { reference: c.reference } : {}),
          ...(c.history ? { history: c.history } : {}),
          ...(c.contentParts ? { contentParts: c.contentParts } : {}),
          ...(c.inputVars ? { inputVars: c.inputVars } : {}),
          ...(c.metadata ? { metadata: c.metadata } : {}),
          ...(c.tags ? { tags: c.tags } : {}),
          ...(c.split ? { split: c.split } : {}),
          ...(c.sourceTraceId ? { sourceTraceId: c.sourceTraceId } : {}),
          ...(c.failureMode ? { failureMode: c.failureMode } : {}),
        })),
        {
          upsertBySourceId: Boolean(idCol) || tab === "history",
          signal: ac.signal,
          onProgress: (written, total) => setProgress({ done: written, total }),
        }
      )
      setDone(result)
      // Remember the rule so the next import into this dataset starts there.
      if (useGrading && expectedCol) {
        await updateDataset(datasetId, { defaultGrading: grading })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setController(null)
      setProgress(null)
    }
  }, [
    preview,
    spec,
    directCases,
    tab,
    hfUri,
    hfSplits,
    hfChoiceIdx,
    hfLimit,
    datasetId,
    capability,
    idCol,
    useGrading,
    expectedCol,
    grading,
    reset,
    t,
  ])

  const TABS: { key: SourceTab; label: string }[] = [
    { key: "file", label: t("import.tabs.file") },
    { key: "huggingface", label: t("import.tabs.huggingface") },
    { key: "history", label: t("import.tabs.history") },
    { key: "foreign", label: t("import.tabs.foreign") },
  ]

  return (
    <div className="flex flex-col gap-3" data-testid="import-dialog">
      <div className="flex flex-wrap gap-1">
        {TABS.map((x) => (
          <Button
            key={x.key}
            size="sm"
            variant={tab === x.key ? "secondary" : "ghost"}
            aria-pressed={tab === x.key}
            onClick={() => {
              setTab(x.key)
              clearSource()
            }}
          >
            {x.label}
          </Button>
        ))}
      </div>

      {tab === "file" && (
        <Input
          type="file"
          aria-label={t("import.file.pick")}
          accept=".csv,.json,.jsonl,.ndjson,.yaml,.yml"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
          }}
        />
      )}

      {tab === "huggingface" && (
        <div className="flex flex-col gap-2">
          {!online && <p className="text-destructive text-xs">{t("import.hf.offline")}</p>}
          <div className="flex gap-2">
            <Input
              aria-label={t("import.hf.uri")}
              // i18n-exempt: a literal HuggingFace URI example, typed verbatim
              placeholder="hf://datasets/openai/gsm8k?config=main&split=test"
              value={hfUri}
              onChange={(e) => setHfUri(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!online || !hfUri.trim() || probing}
              onClick={() => void probeHf()}
            >
              {probing && <Loader2Icon className="size-4 animate-spin" />}
              {t("import.hf.probe")}
            </Button>
          </div>
          {hfSplits.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>{t("import.hf.split")}</span>
                <NativeSelect
                  aria-label={t("import.hf.split")}
                  size="sm"
                  wrapperClassName="w-full"
                  value={String(hfChoiceIdx)}
                  onChange={(e) => setHfChoiceIdx(Number(e.target.value))}
                >
                  {hfSplits.map((s, i) => (
                    <NativeSelectOption key={`${s.config}/${s.split}`} value={String(i)}>
                      {s.config} / {s.split}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t("import.hf.limit")}</span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_IMPORT_ROWS}
                  aria-label={t("import.hf.limit")}
                  value={hfLimit}
                  onChange={(e) =>
                    setHfLimit(Math.min(MAX_IMPORT_ROWS, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </label>
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="flex flex-col gap-2">
          {traces.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("import.history.empty")}</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto text-sm">
              {traces.map((tr) => (
                <li key={tr.traceId}>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={picked.has(tr.traceId)}
                      onCheckedChange={() =>
                        setPicked((cur) => {
                          const next = new Set(cur)
                          if (next.has(tr.traceId)) next.delete(tr.traceId)
                          else next.add(tr.traceId)
                          return next
                        })
                      }
                      aria-label={t("import.history.pick", { id: tr.sessionId })}
                    />
                    <span className="truncate">{tr.preview || tr.traceId}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" disabled={picked.size === 0} onClick={stageHistory}>
            {t("import.stage", { count: picked.size })}
          </Button>
        </div>
      )}

      {tab === "foreign" && (
        <div className="flex flex-col gap-2">
          <NativeSelect
            aria-label={t("import.foreign.format")}
            size="sm"
            value={foreignFormat}
            onChange={(e) => setForeignFormat(e.target.value as ForeignFormat)}
          >
            {/* i18n-exempt: third-party product names, not translated */}
            <NativeSelectOption value="promptfoo">promptfoo</NativeSelectOption>
            {/* i18n-exempt: third-party product names, not translated */}
            <NativeSelectOption value="openai-evals">OpenAI Evals</NativeSelectOption>
            {/* i18n-exempt: third-party product names, not translated */}
            <NativeSelectOption value="langsmith">LangSmith</NativeSelectOption>
          </NativeSelect>
          <Input
            type="file"
            aria-label={t("import.foreign.pick")}
            accept=".json,.jsonl,.yaml,.yml"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importForeignFile(f)
            }}
          />
        </div>
      )}

      {/* Column mapping — shared by the two row-based sources. */}
      {parsed && (
        <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="mapping">
          <span className="text-sm font-medium">{t("import.mapping.heading")}</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ColumnSelect
              label={t("import.file.inputColumn")}
              columns={parsed.columns}
              value={inputCol}
              onChange={setInputCol}
            />
            <ColumnSelect
              label={t("import.file.expectedColumn")}
              columns={parsed.columns}
              value={expectedCol}
              onChange={setExpectedCol}
              noneLabel={t("import.file.none")}
            />
            <ColumnSelect
              label={t("import.mapping.idColumn")}
              columns={parsed.columns}
              value={idCol}
              onChange={setIdCol}
              noneLabel={t("import.file.none")}
            />
            <ColumnSelect
              label={t("import.mapping.splitColumn")}
              columns={parsed.columns}
              value={splitCol}
              onChange={setSplitCol}
              noneLabel={t("import.file.none")}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("import.mapping.splitLiteral")}</span>
            <Input
              aria-label={t("import.mapping.splitLiteral")}
              // i18n-exempt: a split identifier is dataset data, typed verbatim
              placeholder="test"
              value={splitLiteral}
              onChange={(e) => setSplitLiteral(e.target.value)}
            />
          </label>

          {expectedCol && (
            <>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={useGrading}
                  onCheckedChange={(checked) => setUseGrading(checked === true)}
                />
                {t("import.mapping.useGrading")}
              </label>
              {useGrading && (
                <GradingEditor
                  value={grading}
                  onChange={setGrading}
                  {...(sampleExpected ? { sampleExpected } : {})}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Preview — every source stops here before anything is written. */}
      {preview && (
        <div className="flex flex-col gap-1" data-testid="import-preview">
          <p className="text-muted-foreground text-xs">
            {tab === "huggingface"
              ? t("import.previewSample", { count: preview.cases.length, total: hfLimit })
              : t("import.preview", { count: preview.cases.length })}
            {preview.skipped.length > 0 &&
              ` · ${t("import.skipped", { count: preview.skipped.length })}`}
          </p>
          <ul className="max-h-32 overflow-y-auto text-xs">
            {preview.cases.slice(0, 5).map((c, i) => (
              <li key={i} className="truncate">
                {c.input}
                {c.reference?.expectedOutput ? ` → ${c.reference.expectedOutput}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {progress && (
        <div className="flex items-center gap-2" data-testid="import-progress">
          <Progress
            className="min-w-0 flex-1"
            value={(progress.done / Math.max(progress.total, 1)) * 100}
            aria-label={t("import.progress", { done: progress.done, total: progress.total })}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {progress.done}/{progress.total}
          </span>
          <Button size="sm" variant="outline" onClick={() => controller?.abort()}>
            {t("import.cancel")}
          </Button>
        </div>
      )}

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {t("import.failed", { error })}
        </p>
      )}
      {done !== null && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
          {t("import.doneUpsert", { added: done.added, updated: done.updated })}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !preview || preview.cases.length === 0}
          onClick={() => void runImport()}
        >
          {busy && <Loader2Icon className="size-4 animate-spin" />}
          {tab === "huggingface"
            ? t("import.actionHf", { count: Math.min(MAX_IMPORT_ROWS, hfLimit) })
            : t("import.action", { count: preview?.cases.length ?? 0 })}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("import.close")}
        </Button>
      </div>
    </div>
  )
}

/** Rebuild the HF URI from the config/split the user actually picked. */
function hfUriForChoice(uri: string, choice?: { config: string; split: string }): string {
  if (!choice) return uri
  const base = uri.split("?")[0]
  return (
    `${base}?config=${encodeURIComponent(choice.config)}` +
    `&split=${encodeURIComponent(choice.split)}`
  )
}

function ColumnSelect({
  label,
  columns,
  value,
  onChange,
  noneLabel,
}: {
  label: string
  columns: string[]
  value: string
  onChange: (v: string) => void
  noneLabel?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <NativeSelect
        aria-label={label}
        size="sm"
        wrapperClassName="w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {noneLabel && <NativeSelectOption value="">{noneLabel}</NativeSelectOption>}
        {columns.map((c) => (
          <NativeSelectOption key={c} value={c}>
            {c}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  )
}

"use client"

/**
 * Multi-source dataset import. Source tabs (segmented buttons, jsdom-friendly):
 *   • File      — CSV / JSON / JSONL / YAML, with a column→field mapping UI.
 *   • HuggingFace — datasets-server import by `hf://datasets/...` URI.
 *   • History   — bulk-promote the app's own recent traces into cases.
 *   • Foreign   — promptfoo / OpenAI-Evals / LangSmith export files.
 * Each source produces an ImportPreview; "Import N cases" persists via addCase.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { addCase } from "@/lib/db/eval-datasets"
import {
  parseCsv,
  parseStructured,
  mapRowsToCases,
  importForeign,
  importHuggingFace,
  tracesToCases,
  type MappingDeps,
} from "@/lib/ai/eval/import"
import { useRecentTraces } from "@/hooks/eval/use-eval-data"
import type {
  FieldSpec,
  ForeignFormat,
  ImportFormat,
  ImportPreview,
  ParsedRows,
} from "@/types/eval/import"

type SourceTab = "file" | "huggingface" | "history" | "foreign"

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

async function persistPreview(datasetId: string, preview: ImportPreview): Promise<number> {
  for (const c of preview.cases) {
    await addCase(datasetId, {
      input: c.input,
      source: c.source,
      ...(c.reference ? { reference: c.reference } : {}),
      ...(c.history ? { history: c.history } : {}),
      ...(c.inputVars ? { inputVars: c.inputVars } : {}),
      ...(c.metadata ? { metadata: c.metadata } : {}),
      ...(c.tags ? { tags: c.tags } : {}),
      ...(c.split ? { split: c.split } : {}),
      ...(c.sourceTraceId ? { sourceTraceId: c.sourceTraceId } : {}),
      ...(c.failureMode ? { failureMode: c.failureMode } : {}),
    })
  }
  return preview.cases.length
}

export interface ImportDialogProps {
  datasetId: string
  capability: string
  onClose: () => void
}

export function ImportDialog({ datasetId, capability, onClose }: ImportDialogProps) {
  const t = useTranslations("eval")
  const [tab, setTab] = useState<SourceTab>("file")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  // ── File tab state ──
  const [parsed, setParsed] = useState<ParsedRows | null>(null)
  const [inputCol, setInputCol] = useState("")
  const [expectedCol, setExpectedCol] = useState("")

  // ── HuggingFace tab state ──
  const [hfUri, setHfUri] = useState("")
  const online = typeof navigator === "undefined" ? true : navigator.onLine

  // ── Foreign tab state ──
  const [foreignFormat, setForeignFormat] = useState<ForeignFormat>("promptfoo")

  // ── History tab state ──
  const traces = useRecentTraces(50)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const reset = () => {
    setError(null)
    setDone(null)
  }

  const onFile = useCallback(async (file: File) => {
    reset()
    try {
      const text = await file.text()
      const fmt = detectFormat(file.name)
      const rows = fmt === "csv" ? parseCsv(text) : parseStructured(text, fmt)
      setParsed(rows)
      setInputCol(rows.columns[0] ?? "")
      setExpectedCol(rows.columns[1] ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const filePreview = useMemo<ImportPreview | null>(() => {
    if (!parsed || !inputCol) return null
    const spec: FieldSpec = { input: inputCol, ...(expectedCol ? { expected: expectedCol } : {}) }
    return mapRowsToCases(parsed, spec, makeDeps(datasetId, capability))
  }, [parsed, inputCol, expectedCol, datasetId, capability])

  const runImport = useCallback(
    async (preview: ImportPreview | null) => {
      if (!preview || preview.cases.length === 0) return
      reset()
      try {
        const n = await persistPreview(datasetId, preview)
        setDone(n)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [datasetId]
  )

  const importHf = useCallback(async () => {
    reset()
    try {
      const preview = await importHuggingFace(
        hfUri,
        { input: "question", expected: "answer" },
        makeDeps(datasetId, capability)
      )
      await runImport(preview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hfUri, datasetId, capability, runImport])

  const importForeignFile = useCallback(
    async (file: File) => {
      reset()
      try {
        const text = await file.text()
        const raw: unknown =
          foreignFormat === "openai-evals" ? parseStructured(text, "jsonl").rows : JSON.parse(text)
        const preview = importForeign(foreignFormat, raw, makeDeps(datasetId, capability))
        await runImport(preview)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [foreignFormat, datasetId, capability, runImport]
  )

  const importHistory = useCallback(async () => {
    reset()
    const preview = tracesToCases(traces, makeDeps(datasetId, capability), {
      traceIds: [...picked],
    })
    await runImport(preview)
  }, [traces, picked, datasetId, capability, runImport])

  const TABS: { key: SourceTab; label: string }[] = [
    { key: "file", label: t("import.tabs.file") },
    { key: "huggingface", label: t("import.tabs.huggingface") },
    { key: "history", label: t("import.tabs.history") },
    { key: "foreign", label: t("import.tabs.foreign") },
  ]

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="import-dialog">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("import.heading")}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("import.close")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {TABS.map((x) => (
          <Button
            key={x.key}
            size="sm"
            variant={tab === x.key ? "secondary" : "ghost"}
            aria-pressed={tab === x.key}
            onClick={() => {
              setTab(x.key)
              reset()
            }}
          >
            {x.label}
          </Button>
        ))}
      </div>

      {tab === "file" && (
        <div className="flex flex-col gap-2">
          <input
            type="file"
            aria-label={t("import.file.pick")}
            accept=".csv,.json,.jsonl,.ndjson,.yaml,.yml"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
            }}
          />
          {parsed && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>{t("import.file.inputColumn")}</span>
                <select
                  aria-label={t("import.file.inputColumn")}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={inputCol}
                  onChange={(e) => setInputCol(e.target.value)}
                >
                  {parsed.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t("import.file.expectedColumn")}</span>
                <select
                  aria-label={t("import.file.expectedColumn")}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={expectedCol}
                  onChange={(e) => setExpectedCol(e.target.value)}
                >
                  <option value="">{t("import.file.none")}</option>
                  {parsed.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {filePreview && (
            <>
              <p className="text-muted-foreground text-xs">
                {t("import.preview", { count: filePreview.cases.length })}
              </p>
              <ul className="max-h-32 overflow-y-auto text-xs">
                {filePreview.cases.slice(0, 5).map((c, i) => (
                  <li key={i} className="truncate">
                    {c.input}
                  </li>
                ))}
              </ul>
              <Button size="sm" onClick={() => void runImport(filePreview)}>
                {t("import.action", { count: filePreview.cases.length })}
              </Button>
            </>
          )}
        </div>
      )}

      {tab === "huggingface" && (
        <div className="flex flex-col gap-2">
          {!online && <p className="text-destructive text-xs">{t("import.hf.offline")}</p>}
          <Input
            aria-label={t("import.hf.uri")}
            placeholder="hf://datasets/owner/name?split=test"
            value={hfUri}
            onChange={(e) => setHfUri(e.target.value)}
          />
          <Button size="sm" disabled={!online || !hfUri.trim()} onClick={() => void importHf()}>
            {t("import.hf.fetch")}
          </Button>
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
                    <input
                      type="checkbox"
                      checked={picked.has(tr.traceId)}
                      onChange={() =>
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
          <Button size="sm" disabled={picked.size === 0} onClick={() => void importHistory()}>
            {t("import.action", { count: picked.size })}
          </Button>
        </div>
      )}

      {tab === "foreign" && (
        <div className="flex flex-col gap-2">
          <select
            aria-label={t("import.foreign.format")}
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={foreignFormat}
            onChange={(e) => setForeignFormat(e.target.value as ForeignFormat)}
          >
            <option value="promptfoo">promptfoo</option>
            <option value="openai-evals">OpenAI Evals</option>
            <option value="langsmith">LangSmith</option>
          </select>
          <input
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

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {t("import.failed", { error })}
        </p>
      )}
      {done !== null && (
        <p className="text-emerald-600 text-sm" role="status">
          {t("import.done", { count: done })}
        </p>
      )}
    </div>
  )
}

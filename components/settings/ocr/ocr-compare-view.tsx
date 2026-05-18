"use client"

/**
 * Compare view — full-width multi-provider OCR comparison.
 *
 * Lets the user pick 2-3 providers from the sidebar, drop a single file, and
 * run all of them in parallel via `useOcr().run()`. The result panel shows
 * one column per provider with capability summary, duration, cost, and the
 * extracted Markdown. A single shared `AlertDialog` confirms the **summed**
 * cost across selected providers before any extract() runs.
 *
 * The multi-select + column-grid pattern is lifted from
 * `components/settings/provider/provider-comparison-view.tsx`.
 */

import * as React from "react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeft, ChevronDown, FileImage, Layers, Play, X } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { estimateOcrCost, OCR_PROVIDER_CAPABILITIES } from "@/lib/ocr/capabilities"
import type { OcrResult } from "@/lib/ocr/types"
import { OcrCapabilityCostCell, OcrCapabilityValueCell } from "./ocr-capability-cell"
import { OcrResultInline } from "./ocr-result-inline"

const MAX_PROVIDERS = 3

export interface OcrCompareProviderOption {
  id: string
  label: string
}

export interface OcrCompareViewProps {
  providers: OcrCompareProviderOption[]
  /** Initial selection — typically empty when entering via the sidebar entry. */
  initialSelectedIds?: readonly string[]
  /** Back-to-default-view handler. Wired by `ocr-section.tsx`. */
  onBack: () => void
  /** Factory yielding OCR ExtractDeps when ready; mirrors `OcrTryItTab`. */
  depsFactory: () => ExtractDeps | null
}

type ColumnState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "success"; result: OcrResult }
  | { kind: "error"; code: string; message: string }

export function OcrCompareView({
  providers,
  initialSelectedIds = [],
  onBack,
  depsFactory,
}: OcrCompareViewProps): React.ReactElement {
  const t = useTranslations()
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    [...initialSelectedIds].slice(0, MAX_PROVIDERS)
  )
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [columns, setColumns] = useState<Record<string, ColumnState>>({})
  const controllerRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const toggleProvider = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_PROVIDERS) return prev
      return [...prev, id]
    })
  }

  const isPdf = file?.type === "application/pdf"
  const estimatedPages = isPdf ? 5 : 1
  const totalCost = useMemo(
    () => selectedIds.reduce((sum, id) => sum + estimateOcrCost(id, estimatedPages), 0),
    [selectedIds, estimatedPages]
  )

  const handleFileChosen = (next: File | null) => {
    setFile(next)
    setColumns({})
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const first = event.dataTransfer.files[0]
    if (first) handleFileChosen(first)
  }

  const handleRunRequested = () => {
    if (!file || selectedIds.length === 0) return
    setConfirmOpen(true)
  }

  const runAll = useCallback(async () => {
    setConfirmOpen(false)
    if (!file || selectedIds.length === 0) return
    const deps = depsFactory()
    if (!deps) {
      const err: ColumnState = {
        kind: "error",
        code: "provider_failed",
        message: t("ocr.compare.runtimeNotReady"),
      }
      setColumns(Object.fromEntries(selectedIds.map((id) => [id, err])))
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setColumns(
      Object.fromEntries(selectedIds.map((id) => [id, { kind: "running" } as ColumnState]))
    )
    const settled = await Promise.allSettled(
      selectedIds.map((providerId) =>
        extract(
          {
            source: { kind: "blob", blob: file, mimeType: file.type },
            providerId,
            signal: controller.signal,
            useCache: true,
          },
          deps
        )
      )
    )
    const nextColumns: Record<string, ColumnState> = {}
    settled.forEach((outcome, idx) => {
      const providerId = selectedIds[idx]
      if (outcome.status === "fulfilled") {
        nextColumns[providerId] = { kind: "success", result: outcome.value }
      } else {
        const err = outcome.reason as { code?: string; message?: string }
        nextColumns[providerId] = {
          kind: "error",
          code: typeof err?.code === "string" ? err.code : "provider_failed",
          message: typeof err?.message === "string" ? err.message : String(err),
        }
      }
    })
    setColumns(nextColumns)
    controllerRef.current = null
  }, [file, selectedIds, depsFactory, t])

  const handleAbort = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }

  const anyRunning = Object.values(columns).some((c) => c.kind === "running")

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="ocr-compare-view">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 pl-1">
          <ArrowLeft className="h-4 w-4" />
          {t("ocr.compare.back")}
        </Button>
        <div className="flex flex-1 items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("ocr.compare.title")}</h2>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("ocr.compare.maxSelected", { max: MAX_PROVIDERS })}
        </span>
      </div>

      {/* Provider picker */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.length >= MAX_PROVIDERS}
              data-testid="ocr-compare-add-provider"
            >
              {t("ocr.compare.addProvider")}
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <ScrollArea className="max-h-72">
              {providers.map((p) => {
                const isChecked = selectedIds.includes(p.id)
                const disabled = !isChecked && selectedIds.length >= MAX_PROVIDERS
                return (
                  <label
                    key={p.id}
                    htmlFor={`compare-${p.id}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted",
                      disabled && "opacity-50 pointer-events-none"
                    )}
                    data-testid={`ocr-compare-option-${p.id}`}
                  >
                    <Checkbox
                      id={`compare-${p.id}`}
                      checked={isChecked}
                      onCheckedChange={() => toggleProvider(p.id)}
                    />
                    <span className="flex-1 truncate">{p.label}</span>
                  </label>
                )
              })}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        {selectedIds.map((id) => {
          const provider = providers.find((p) => p.id === id)
          return (
            <Badge
              key={id}
              variant="secondary"
              className="flex items-center gap-1 pr-1 text-xs"
              data-testid={`ocr-compare-chip-${id}`}
            >
              <span>{provider?.label ?? id}</span>
              <button
                className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => toggleProvider(id)}
                aria-label={t("ocr.compare.removeProvider", { provider: provider?.label ?? id })}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          )
        })}
      </div>

      {/* File input + Run */}
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/20"
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          data-testid="ocr-compare-drop-zone"
        >
          <FileImage className="h-6 w-6 text-muted-foreground" aria-hidden />
          {file ? (
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm font-medium" data-testid="ocr-compare-file-name">
                {file.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB · {file.type || "unknown"}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleFileChosen(null)}
                data-testid="ocr-compare-clear-file"
              >
                <X className="mr-1 h-3.5 w-3.5" />
                {t("ocr.compare.clearFile")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm">{t("ocr.compare.dropHere")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="ocr-compare-pick-file"
              >
                {t("ocr.compare.pickFile")}
              </Button>
            </div>
          )}
          <Input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
            data-testid="ocr-compare-file-input"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleRunRequested}
            disabled={!file || selectedIds.length === 0 || anyRunning}
            data-testid="ocr-compare-run-all"
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {anyRunning ? t("ocr.compare.running") : t("ocr.compare.runAll")}
          </Button>
          {anyRunning && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAbort}
              data-testid="ocr-compare-abort"
            >
              {t("ocr.compare.abort")}
            </Button>
          )}
        </div>
      </div>

      {/* Result columns */}
      <div className="flex-1 overflow-auto p-4">
        {selectedIds.length === 0 ? (
          <p
            className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground"
            data-testid="ocr-compare-empty"
          >
            {t("ocr.compare.noProvidersSelected")}
          </p>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(${selectedIds.length}, minmax(260px, 1fr))` }}
          >
            {selectedIds.map((id) => {
              const provider = providers.find((p) => p.id === id)
              const caps = OCR_PROVIDER_CAPABILITIES[id]
              const state = columns[id] ?? { kind: "idle" }
              return (
                <article
                  key={id}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                  data-testid={`ocr-compare-column-${id}`}
                >
                  <header className="flex items-center justify-between gap-2 border-b pb-2">
                    <div>
                      <h3 className="text-sm font-semibold">{provider?.label ?? id}</h3>
                      <p className="text-[10px] text-muted-foreground">{id}</p>
                    </div>
                    {caps && <OcrCapabilityCostCell tier={caps.costTier} />}
                  </header>
                  {caps && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <CapabilityChip
                        label={t("ocr.capabilities.fields.handwriting.label")}
                        value={caps.handwriting}
                      />
                      <CapabilityChip
                        label={t("ocr.capabilities.fields.tables.label")}
                        value={caps.tables}
                      />
                      <CapabilityChip
                        label={t("ocr.capabilities.fields.math.label")}
                        value={caps.math}
                      />
                      <CapabilityChip
                        label={t("ocr.capabilities.fields.offline.label")}
                        value={caps.offline}
                      />
                    </div>
                  )}
                  <div className="mt-2">
                    {state.kind === "idle" && (
                      <p
                        className="text-xs italic text-muted-foreground"
                        data-testid={`ocr-compare-state-idle-${id}`}
                      >
                        {t("ocr.compare.columnIdle")}
                      </p>
                    )}
                    {state.kind === "running" && (
                      <Skeleton
                        className="h-24 w-full"
                        data-testid={`ocr-compare-state-running-${id}`}
                      />
                    )}
                    {state.kind === "error" && (
                      <Alert variant="destructive" data-testid={`ocr-compare-state-error-${id}`}>
                        <AlertDescription>
                          <strong className="block">{state.code}</strong>
                          <span>{state.message}</span>
                        </AlertDescription>
                      </Alert>
                    )}
                    {state.kind === "success" && (
                      <OcrResultInline result={state.result} showCombinedCopy={false} />
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="ocr-compare-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ocr.compare.confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ocr.compare.confirm.body", {
                count: selectedIds.length,
                cost: totalCost === 0 ? t("ocr.compare.confirm.free") : `$${totalCost.toFixed(4)}`,
                pages: estimatedPages,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="ocr-compare-confirm-cancel">
              {t("ocr.compare.confirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void runAll()} data-testid="ocr-compare-confirm-ok">
              {t("ocr.compare.confirm.cta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CapabilityChip({ label, value }: { label: string; value: "yes" | "no" | "partial" }) {
  return (
    <span className="inline-flex items-center gap-1">
      <OcrCapabilityValueCell value={value} className="h-3 w-3" />
      <span>{label}</span>
    </span>
  )
}

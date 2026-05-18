"use client"

/**
 * OCR Try It tab — single-provider playground.
 *
 * Lets the user drop or pick an image / PDF, see the estimated cost in an
 * AlertDialog, confirm, then run the selected provider through `useOcr()` and
 * render the per-page result inline (no Sheet drawer — we want to stay on the
 * settings page).
 */

import * as React from "react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FileImage, Play, X } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { estimateOcrCost } from "@/lib/ocr/capabilities"
import { useOcr } from "@/hooks/use-ocr"
import type { ExtractDeps } from "@/lib/ocr/index"
import { OcrResultInline } from "../ocr-result-inline"

export interface OcrTryItTabProps {
  providerId: string
  /** Factory yielding the OCR ExtractDeps when ready (registry installed, etc.). */
  depsFactory: () => ExtractDeps | null
  /** Caller-provided copy handler — defaults to `navigator.clipboard.writeText`. */
  onCopy?: (text: string) => Promise<void> | void
}

const ACCEPT = "image/*,application/pdf"

export function OcrTryItTab({
  providerId,
  depsFactory,
  onCopy,
}: OcrTryItTabProps): React.ReactElement {
  const t = useTranslations()
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const ocr = useOcr(depsFactory)

  const isPdf = file?.type === "application/pdf"
  const estimatedPages = isPdf ? 5 : 1
  const estimatedCost = useMemo(
    () => estimateOcrCost(providerId, estimatedPages),
    [providerId, estimatedPages]
  )

  const handlePick = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFileChosen = useCallback(
    (next: File | null) => {
      setFile(next)
      ocr.reset()
    },
    [ocr]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragOver(false)
      const first = event.dataTransfer.files[0]
      if (first) handleFileChosen(first)
    },
    [handleFileChosen]
  )

  const handleClear = useCallback(() => {
    handleFileChosen(null)
    if (inputRef.current) inputRef.current.value = ""
  }, [handleFileChosen])

  const handleRunRequested = useCallback(() => {
    if (!file) return
    setConfirmOpen(true)
  }, [file])

  const handleConfirmed = useCallback(async () => {
    setConfirmOpen(false)
    if (!file) return
    await ocr.run({
      source: { kind: "blob", blob: file, mimeType: file.type },
      providerId,
      useCache: true,
    })
  }, [file, ocr, providerId])

  const handleCopy = useCallback(
    async (text: string) => {
      if (onCopy) return onCopy(text)
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
      }
    },
    [onCopy]
  )

  return (
    <div className="space-y-5" data-testid="ocr-try-it-tab">
      <header className="space-y-1">
        <h4 className="text-sm font-medium">{t("ocr.tryIt.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("ocr.tryIt.description")}</p>
      </header>

      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/20"
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        data-testid="ocr-try-it-drop-zone"
      >
        <FileImage className="h-6 w-6 text-muted-foreground" aria-hidden />
        {file ? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-sm font-medium" data-testid="ocr-try-it-file-name">
              {file.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {(file.size / 1024).toFixed(1)} KB · {file.type || "unknown"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              data-testid="ocr-try-it-clear-file"
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {t("ocr.tryIt.clearFile")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm">{t("ocr.tryIt.dropHere")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePick}
              data-testid="ocr-try-it-pick-file"
            >
              {t("ocr.tryIt.pickFile")}
            </Button>
          </div>
        )}
        <Input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
          data-testid="ocr-try-it-file-input"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={handleRunRequested}
          disabled={!file || ocr.status === "running"}
          data-testid="ocr-try-it-run"
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          {ocr.status === "running" ? t("ocr.tryIt.running") : t("ocr.tryIt.runButton")}
        </Button>
        {ocr.status === "running" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={ocr.abort}
            data-testid="ocr-try-it-abort"
          >
            {t("ocr.tryIt.abort")}
          </Button>
        )}
      </div>

      {ocr.status === "error" && ocr.error && (
        <Alert variant="destructive" data-testid="ocr-try-it-error">
          <AlertDescription>
            <strong className="block">{ocr.error.code}</strong>
            <span>{ocr.error.message}</span>
          </AlertDescription>
        </Alert>
      )}

      {ocr.status === "success" && ocr.result && (
        <OcrResultInline
          result={ocr.result}
          onCopy={handleCopy}
          onCopyPage={(_, text) => handleCopy(text)}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="ocr-try-it-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ocr.tryIt.confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ocr.tryIt.confirm.estimatedCost", {
                cost:
                  estimatedCost === 0
                    ? t("ocr.tryIt.confirm.free")
                    : `$${estimatedCost.toFixed(4)}`,
                pages: estimatedPages,
                provider: providerId,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="ocr-try-it-confirm-cancel">
              {t("ocr.tryIt.confirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmed()}
              data-testid="ocr-try-it-confirm-ok"
            >
              {t("ocr.tryIt.confirm.cta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

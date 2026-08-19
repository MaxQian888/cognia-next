"use client"

/**
 * Take one trace out of the app — clipboard or file, raw JSON or OTLP.
 *
 * A trace you can only look at is a trace you cannot escalate: attaching it to
 * a bug report, replaying it as a fixture, or opening it in Jaeger/Tempo all
 * need it outside this window. OTLP goes through `spansToOtlp`, the same
 * converter the `otlp-http` transport uses, so an exported trace and a
 * streamed one are the same bytes.
 *
 * Writes go through the shared cross-platform `saveExport` (Tauri dialog /
 * Capacitor / web download), matching the observability dashboard's export.
 *
 * "Strip content previews" is offered because an export leaves the machine:
 * previews only exist when the user enabled content capture AND the redaction
 * gate passed, but a redacted prompt is still a prompt, and a bug report has a
 * wider audience than a local pane.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, CopyIcon, DownloadIcon, ShareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCopy } from "@/hooks/ui"
import { saveExport } from "@/lib/files/save-export"
import {
  TRACE_EXPORT_FORMATS,
  serializeTrace,
  traceExportFilename,
  traceExportMimeType,
  type TraceExportFormat,
} from "@/lib/observability/trace-export"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface TraceExportMenuProps {
  traceId: string
  spans: AgentTraceSpan[]
  /** Injected for deterministic filenames under test. */
  now?: () => number
  className?: string
}

export function TraceExportMenu({
  traceId,
  spans,
  now = Date.now,
  className,
}: TraceExportMenuProps) {
  const t = useTranslations("logging.workspace.traces.export")
  const { copied, copy } = useCopy()
  const [redactPreviews, setRedactPreviews] = useState(false)

  const hasPreviews = spans.some((span) => span.inputPreview || span.outputPreview)
  const disabled = spans.length === 0

  const handleCopy = useCallback(
    async (format: TraceExportFormat) => {
      const ok = await copy(serializeTrace(spans, format, { redactPreviews }))
      if (ok) toast.success(t("copied", { format: format.toUpperCase() }))
      else toast.error(t("copyFailed"))
    },
    [copy, spans, redactPreviews, t]
  )

  const handleDownload = useCallback(
    async (format: TraceExportFormat) => {
      const outcome = await saveExport({
        filename: traceExportFilename(traceId, format, now()),
        data: serializeTrace(spans, format, { redactPreviews }),
        mimeType: traceExportMimeType(format),
      })
      if (outcome.kind === "error") toast.error(t("saveFailed", { message: outcome.message }))
      else if (outcome.kind !== "cancelled") toast.success(t("saved"))
    },
    [traceId, spans, redactPreviews, now, t]
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
          disabled={disabled}
          aria-label={t("label")}
          data-testid="trace-export-trigger"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <ShareIcon className="size-3.5" />}
          <span className="hidden sm:inline">{t("label")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">
          {t("spanCount", { count: spans.length })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {TRACE_EXPORT_FORMATS.map((format) => (
            <DropdownMenuItem
              key={`copy-${format}`}
              onSelect={() => void handleCopy(format)}
              data-testid={`trace-export-copy-${format}`}
            >
              <CopyIcon className="mr-2 size-3.5" />
              {t(`copy.${format}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {TRACE_EXPORT_FORMATS.map((format) => (
            <DropdownMenuItem
              key={`save-${format}`}
              onSelect={() => void handleDownload(format)}
              data-testid={`trace-export-save-${format}`}
            >
              <DownloadIcon className="mr-2 size-3.5" />
              {t(`save.${format}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {hasPreviews && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={redactPreviews}
              onCheckedChange={setRedactPreviews}
              onSelect={(event) => event.preventDefault()}
              data-testid="trace-export-redact"
            >
              {t("redactPreviews")}
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TraceExportMenu

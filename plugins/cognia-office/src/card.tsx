"use client"

/**
 * Rich chat card for the `office_*` tool results, registered through
 * `ctx.toolResult.registerToolResultRenderer`. Strings come from the plugin's
 * own `plugin.json` bundle through `usePluginTranslations` (same lookup as
 * `ctx.i18n.t`, re-rendering on a language switch); the "Open" action is
 * bound per activation by `createWorkbookResultCard`, so no module-level
 * state outlives a plugin reload.
 *
 * The host renders a registered plugin card as JSX and never falls back to
 * its generic tool card, so this card owns every state of the call: running,
 * failed, cancelled, unreadable, and each result shape.
 */

import { FileSpreadsheetIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button, ToolCard, parseToolOutput } from "@cognia/plugin-ui"

export const OFFICE_PLUGIN_ID = "cognia-office"

export interface WorkbookResultCardDeps {
  /** Opens the artifact panel; omitted when the host has no panel to open. */
  openArtifact?: (artifactId: string) => void
}

interface SheetLike {
  title?: string
}

interface ResultPayload {
  ok?: boolean
  saved?: boolean
  cancelled?: boolean
  requiresConfirmation?: boolean
  artifactId?: string
  version?: number
  currentVersion?: number
  byteLength?: number
  title?: string
  summary?: { title?: string; sheets?: SheetLike[] }
  sheets?: SheetLike[]
  versions?: unknown[]
  cellsReturned?: number
  truncated?: boolean
  findings?: Array<{ severity?: string }>
  error?: string
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `tool-office_sync_lark` → `office_sync_lark`. */
function toolName(part: ToolResultRendererProps["part"]): string {
  const typed = part as { type?: string; toolName?: string }
  if (typeof typed.toolName === "string") return typed.toolName
  return typeof typed.type === "string" ? typed.type.replace(/^tool-/, "") : ""
}

/**
 * A one-line card for the states with no result to describe. Plugin cards get
 * no host fallback, so a pending, failed, or cancelled call still says so.
 */
function StatusCard({
  title,
  testId,
  message,
  detail,
  alert = false,
}: {
  title: string
  testId: string
  message: string
  detail?: string
  alert?: boolean
}) {
  return (
    <ToolCard title={title} testId={testId}>
      <p
        role={alert ? "alert" : "status"}
        data-testid={`${testId}-status`}
        className={alert ? "text-destructive" : "text-muted-foreground"}
      >
        {message}
      </p>
      {detail ? (
        <p className="mt-1 text-[11px] break-words text-muted-foreground">{detail}</p>
      ) : null}
    </ToolCard>
  )
}

export function createWorkbookResultCard(deps: WorkbookResultCardDeps = {}) {
  function WorkbookResultCard({ part }: ToolResultRendererProps) {
    const t = usePluginTranslations(OFFICE_PLUGIN_ID)
    const cardTitle = t("card.title")
    const callState = (part as { state?: string }).state
    if (callState === "input-streaming" || callState === "input-available")
      return (
        <StatusCard title={cardTitle} testId="workbook-result-card" message={t("card.running")} />
      )
    if (callState === "output-error")
      return (
        <StatusCard
          title={cardTitle}
          testId="workbook-result-card"
          alert
          message={t("card.failed")}
          detail={(part as { errorText?: string }).errorText}
        />
      )
    const payload = parseToolOutput((part as { output?: unknown }).output) as ResultPayload | null
    if (!payload || typeof payload !== "object")
      return (
        <StatusCard
          title={cardTitle}
          testId="workbook-result-card"
          alert
          message={t("card.unreadable")}
        />
      )
    if (payload.cancelled)
      return (
        <StatusCard title={cardTitle} testId="workbook-result-card" message={t("card.cancelled")} />
      )
    if (!payload.artifactId)
      return (
        <StatusCard
          title={cardTitle}
          testId="workbook-result-card"
          alert
          message={t("card.failed")}
          detail={payload.error}
        />
      )

    const findings = Array.isArray(payload.findings) ? payload.findings : []
    const errors = findings.filter((finding) => finding.severity === "error").length
    const warnings = findings.length - errors
    const title = payload.summary?.title ?? payload.title
    const sheets = payload.summary?.sheets ?? payload.sheets
    const version = payload.version ?? payload.currentVersion
    // An export that was refused still reports why; only a real write is "Exported".
    const exported =
      payload.ok === true && payload.saved === true && typeof payload.byteLength === "number"
    const synced = payload.ok === true && toolName(part) === "office_sync_lark"
    const { openArtifact } = deps

    return (
      <ToolCard
        title={cardTitle}
        testId="workbook-result-card"
        action={
          openArtifact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-9 px-3 text-xs sm:h-7 sm:px-2 sm:text-[11px]"
              onClick={() => openArtifact(payload.artifactId!)}
              data-testid="workbook-result-open"
            >
              {t("card.open")}
            </Button>
          ) : undefined
        }
      >
        <div className="flex items-start gap-2">
          <FileSpreadsheetIcon
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            {title ? (
              <p className="truncate font-medium" data-testid="workbook-result-title">
                {title}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {Array.isArray(sheets) ? (
                <span data-testid="workbook-result-sheets">
                  {t("card.sheets", { count: sheets.length })}
                </span>
              ) : null}
              {typeof version === "number" ? <span>{t("card.version", { version })}</span> : null}
              {typeof payload.cellsReturned === "number" ? (
                <span data-testid="workbook-result-read">
                  {t("card.read", { count: payload.cellsReturned })}
                </span>
              ) : null}
              {Array.isArray(payload.versions) ? (
                <span data-testid="workbook-result-versions">
                  {t("card.versions", { count: payload.versions.length })}
                </span>
              ) : null}
              {exported ? (
                <span data-testid="workbook-result-exported">
                  {t("card.exported", { size: formatBytes(payload.byteLength!) })}
                </span>
              ) : null}
              {synced ? <span data-testid="workbook-result-synced">{t("card.synced")}</span> : null}
              {payload.truncated ? (
                <Badge variant="outline" className="text-[10px]">
                  {t("card.truncated")}
                </Badge>
              ) : null}
              {payload.requiresConfirmation ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t("card.needsConfirmation")}
                </Badge>
              ) : null}
              {errors > 0 ? (
                <Badge variant="destructive" className="text-[10px]">
                  {t("card.errors", { count: errors })}
                </Badge>
              ) : null}
              {warnings > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t("card.warnings", { count: warnings })}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </ToolCard>
    )
  }
  return WorkbookResultCard
}

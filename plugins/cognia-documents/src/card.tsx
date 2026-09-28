"use client"

/**
 * Rich chat card for the `documents_*` tool results, registered through
 * `ctx.toolResult.registerToolResultRenderer`. Strings come from the plugin's
 * own `plugin.json` bundle through `usePluginTranslations` (same lookup as
 * `ctx.i18n.t`, re-rendering on a language switch); the "Open" action is
 * bound per activation by `createDocumentResultCard`, so no module-level
 * state outlives a plugin reload.
 *
 * The host renders a registered plugin card as JSX and never falls back to
 * its generic tool card, so this card owns every state of the call: running,
 * failed, cancelled, unreadable, and each result shape.
 */

import { FileTextIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button, ToolCard, parseToolOutput } from "@cognia/plugin-ui"

export const DOCUMENTS_PLUGIN_ID = "cognia-documents"

export interface DocumentResultCardDeps {
  /** Opens the artifact panel; omitted when the host has no panel to open. */
  openArtifact?: (artifactId: string) => void
}

interface ResultPayload {
  ok?: boolean
  saved?: boolean
  cancelled?: boolean
  requiresConfirmation?: boolean
  artifactId?: string
  filename?: string
  version?: number
  currentVersion?: number
  byteLength?: number
  title?: string
  summary?: {
    title?: string
    blockCount?: number
    comments?: { open?: number }
    changes?: { pending?: number }
  }
  model?: { title?: string; blocks?: unknown[] }
  versions?: unknown[]
  comments?: Array<{ resolved?: boolean }>
  changes?: Array<{ accepted?: boolean }>
  conversionNotes?: string[]
  findings?: Array<{ severity?: string }>
  error?: string
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

export function createDocumentResultCard(deps: DocumentResultCardDeps = {}) {
  function DocumentResultCard({ part }: ToolResultRendererProps) {
    const t = usePluginTranslations(DOCUMENTS_PLUGIN_ID)
    const cardTitle = t("card.title")
    const callState = (part as { state?: string }).state
    if (callState === "input-streaming" || callState === "input-available")
      return (
        <StatusCard title={cardTitle} testId="document-result-card" message={t("card.running")} />
      )
    if (callState === "output-error")
      return (
        <StatusCard
          title={cardTitle}
          testId="document-result-card"
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
          testId="document-result-card"
          alert
          message={t("card.unreadable")}
        />
      )
    if (payload.cancelled)
      return (
        <StatusCard title={cardTitle} testId="document-result-card" message={t("card.cancelled")} />
      )
    // A saved transcript has no artifact, but it is still a document result.
    const savedFile = payload.ok === true && payload.saved === true
    if (!payload.artifactId && !savedFile)
      return (
        <StatusCard
          title={cardTitle}
          testId="document-result-card"
          alert
          message={t("card.failed")}
          detail={payload.error}
        />
      )

    const findings = Array.isArray(payload.findings) ? payload.findings : []
    const errors = findings.filter((finding) => finding.severity === "error").length
    const warnings = findings.length - errors
    const title =
      payload.summary?.title ?? payload.model?.title ?? payload.title ?? payload.filename
    const blockCount = payload.summary?.blockCount ?? payload.model?.blocks?.length
    const openComments =
      payload.summary?.comments?.open ??
      payload.comments?.filter((comment) => !comment.resolved).length
    const pendingChanges =
      payload.summary?.changes?.pending ??
      payload.changes?.filter((change) => !change.accepted).length
    const version = payload.version ?? payload.currentVersion
    const exported = savedFile && typeof payload.byteLength === "number"
    const { openArtifact } = deps

    return (
      <ToolCard
        title={cardTitle}
        testId="document-result-card"
        action={
          payload.artifactId && openArtifact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-9 px-3 text-xs sm:h-7 sm:px-2 sm:text-[11px]"
              onClick={() => openArtifact(payload.artifactId!)}
              data-testid="document-result-open"
            >
              {t("card.open")}
            </Button>
          ) : undefined
        }
      >
        <div className="flex items-start gap-2">
          <FileTextIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            {title ? (
              <p className="truncate font-medium" data-testid="document-result-title">
                {title}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {typeof blockCount === "number" ? (
                <span data-testid="document-result-blocks">
                  {t("card.blocks", { count: blockCount })}
                </span>
              ) : null}
              {typeof version === "number" ? <span>{t("card.version", { version })}</span> : null}
              {Array.isArray(payload.versions) ? (
                <span data-testid="document-result-versions">
                  {t("card.versions", { count: payload.versions.length })}
                </span>
              ) : null}
              {openComments ? (
                <span data-testid="document-result-comments">
                  {t("card.openComments", { count: openComments })}
                </span>
              ) : null}
              {pendingChanges ? (
                <span data-testid="document-result-changes">
                  {t("card.pendingChanges", { count: pendingChanges })}
                </span>
              ) : null}
              {exported ? (
                <span data-testid="document-result-exported">
                  {t("card.exported", { size: formatBytes(payload.byteLength!) })}
                </span>
              ) : null}
              {payload.conversionNotes?.length ? (
                <Badge variant="outline" className="text-[10px]">
                  {t("card.flattened")}
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
  return DocumentResultCard
}

"use client"

/**
 * Rich chat card for the `presentations_*` tool results, registered through
 * `ctx.toolResult.registerToolResultRenderer`. Strings come from the plugin's
 * own `plugin.json` bundle through `usePluginTranslations` (same lookup as
 * `ctx.i18n.t`, re-rendering on a language switch); the "Open" action is
 * bound per activation by `createPresentationResultCard`, so no module-level
 * state outlives a plugin reload.
 */

import { PresentationIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button, ToolCard, parseToolOutput } from "@cognia/plugin-ui"

export const PRESENTATIONS_PLUGIN_ID = "cognia-presentations"

export interface PresentationResultCardDeps {
  /** Opens the artifact panel; omitted when the host has no panel to open. */
  openArtifact?: (artifactId: string) => void
}

interface FindingLike {
  severity?: string
}

interface ResultPayload {
  ok?: boolean
  saved?: boolean
  cancelled?: boolean
  artifactId?: string
  version?: number
  byteLength?: number
  deck?: { title?: string; slides?: unknown[] }
  findings?: FindingLike[]
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function createPresentationResultCard(deps: PresentationResultCardDeps = {}) {
  function PresentationResultCard({ part }: ToolResultRendererProps) {
    const t = usePluginTranslations(PRESENTATIONS_PLUGIN_ID)
    const payload = parseToolOutput((part as { output?: unknown }).output) as ResultPayload | null
    if (!payload || typeof payload !== "object") return null
    if (payload.cancelled || (!payload.artifactId && !payload.deck)) return null

    const findings = Array.isArray(payload.findings) ? payload.findings : []
    const errors = findings.filter((finding) => finding.severity === "error").length
    const warnings = findings.length - errors
    const slideCount = payload.deck?.slides?.length
    // An export that failed validation or was refused still reports the
    // byte length it would have written — only a real write is "Exported".
    const exported = payload.ok === true && typeof payload.byteLength === "number"
    const { openArtifact } = deps

    return (
      <ToolCard
        title={t("card.title")}
        testId="presentation-result-card"
        action={
          payload.artifactId && openArtifact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-9 px-3 text-xs sm:h-7 sm:px-2 sm:text-[11px]"
              onClick={() => openArtifact(payload.artifactId!)}
              data-testid="presentation-result-open"
            >
              {t("card.open")}
            </Button>
          ) : undefined
        }
      >
        <div className="flex items-start gap-2">
          <PresentationIcon
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            {payload.deck?.title ? (
              <p className="truncate font-medium" data-testid="presentation-result-title">
                {payload.deck.title}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {typeof slideCount === "number" ? (
                <span data-testid="presentation-result-slides">
                  {t("card.slides", { count: slideCount })}
                </span>
              ) : null}
              {typeof payload.version === "number" ? (
                <span>{t("card.version", { version: payload.version })}</span>
              ) : null}
              {exported ? (
                <span data-testid="presentation-result-exported">
                  {t("card.exported", { size: formatBytes(payload.byteLength!) })}
                </span>
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
  return PresentationResultCard
}

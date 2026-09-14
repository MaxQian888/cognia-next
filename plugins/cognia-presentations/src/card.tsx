"use client"

/**
 * Rich chat card for the `presentations_*` tool results, registered through
 * `ctx.toolResult.registerToolResultRenderer`. This plugin ships as an
 * esbuild-bundled browser builtin whose externals are react / lucide-react /
 * @cognia/plugin-sdk / @cognia/plugin-ui — `next-intl` is NOT shared, so the
 * card resolves strings through a translator injected by `activate()` and
 * falls back to the English bundle declared in `plugin.json`.
 */

import { PresentationIcon } from "lucide-react"

import type { ToolResultRendererProps } from "@cognia/plugin-sdk"
import { Badge, Button, ToolCard, parseToolOutput } from "@cognia/plugin-ui"

import { translate, type PresentationTranslate } from "./i18n"

export interface PresentationResultBridge {
  t: PresentationTranslate
  openArtifact?: (artifactId: string) => void
}

let bridge: PresentationResultBridge | null = null

/** Called from activate(); cleared via `ctx.lifecycle.onDispose`. */
export function setPresentationResultBridge(next: PresentationResultBridge | null): void {
  bridge = next
}

function t(key: string, vars?: Record<string, string | number>): string {
  return bridge?.t(key, vars) ?? translate("en", key, vars)
}

interface FindingLike {
  severity?: string
}

interface ResultPayload {
  ok?: boolean
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

export function PresentationResultCard({ part }: ToolResultRendererProps) {
  const payload = parseToolOutput((part as { output?: unknown }).output) as ResultPayload | null
  if (!payload || typeof payload !== "object") return null
  if (payload.cancelled || (!payload.artifactId && !payload.deck)) return null

  const findings = Array.isArray(payload.findings) ? payload.findings : []
  const errors = findings.filter((finding) => finding.severity === "error").length
  const warnings = findings.length - errors
  const slideCount = payload.deck?.slides?.length

  return (
    <ToolCard
      title={t("card.title")}
      badge={
        errors > 0
          ? t("card.errors", { count: errors })
          : warnings > 0
            ? t("card.warnings", { count: warnings })
            : undefined
      }
      testId="presentation-result-card"
      action={
        payload.artifactId && bridge?.openArtifact ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => bridge?.openArtifact?.(payload.artifactId!)}
            data-testid="presentation-result-open"
          >
            {t("card.open")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex items-start gap-2">
        <PresentationIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
            {typeof payload.byteLength === "number" ? (
              <span data-testid="presentation-result-exported">
                {t("card.exported", { size: formatBytes(payload.byteLength) })}
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

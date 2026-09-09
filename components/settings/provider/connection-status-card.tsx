"use client"

/**
 * The pass / limited / stale / failed card that reports one connection test,
 * plus the `ApiTestResult` adapter that feeds it.
 *
 * Lifted out of `provider-config-tab.tsx` because two dialogs
 * (`custom-provider-dialog`, `quick-add-provider-dialog`) render this card and
 * were importing it from a 940-line tab module, dragging the whole connect
 * form and its dependency graph in for about a hundred lines of markup.
 */

import { AlertTriangle, Check, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ApiTestResult } from "@/lib/ai/infrastructure/api-test"

export interface TestResult {
  success: boolean
  latency?: number
  error?: string
  testedAt?: number
  /**
   * `stale` = a previous verification exists but the credentials / endpoint
   * changed since (readiness fingerprint mismatch) — shown as a warning that
   * asks for a re-test rather than as a pass or a failure.
   */
  outcome?: "verified" | "failed" | "limited" | "stale"
  /** True when this card reflects the persisted verification, not a test run
   *  in this session — the "last tested" line then says so. */
  persisted?: boolean
}

/**
 * Adapt a raw `ApiTestResult` (from `useConnectionTest`) to the `TestResult`
 * shape `ConnectionStatusCard` renders. Centralised here — next to both the
 * type and the card — so the success→error / latency_ms→latency mapping isn't
 * copy-pasted (and silently drifted) across the provider dialogs.
 */
export function toConnectionCardResult(result: ApiTestResult): TestResult {
  return {
    success: result.success,
    latency: result.latency_ms,
    error: result.success ? undefined : result.message,
    outcome: result.outcome,
  }
}

interface ConnectionStatusCardProps {
  result: TestResult
}

export function ConnectionStatusCard({ result }: ConnectionStatusCardProps) {
  const t = useTranslations("providers")

  if (result.success && result.outcome !== "limited") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 dark:border-green-900 dark:bg-green-950/30">
        <Check className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-green-700 dark:text-green-400">
            {t("configTab.connectionSuccess")}
          </p>
          {result.latency !== undefined && (
            <p className="text-xs text-green-600 dark:text-green-500">
              {t("configTab.latency")}: {result.latency}ms
            </p>
          )}
          {result.testedAt && (
            <p className="text-xs text-muted-foreground">
              {result.persisted ? t("configTab.lastVerified") : t("configTab.lastTested")}:{" "}
              {result.persisted
                ? new Date(result.testedAt).toLocaleString()
                : new Date(result.testedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>
    )
  }

  // "Limited" means no authoritative request was made — e.g. Anthropic in a
  // browser session, where CORS forces a key-*format* check only
  // (`api-test.ts:testAnthropicConnection`). Read as a pass, that's actively
  // misleading, so the hint spells out what was not done. It lives at
  // `providers.verificationLimitedHint`, next to `providers.verificationLimited`
  // — the headline previously reached for `configTab.verificationLimited`,
  // which does not exist, so next-intl rendered the raw key path here.
  if (result.outcome === "limited") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("verificationLimited")}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
            {t("verificationLimitedHint")}
          </p>
          {result.error && (
            <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5 break-words">
              {result.error}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (result.outcome === "stale") {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30"
        data-testid="connection-status-stale"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("verificationStale")}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
            {t("verificationStaleHint")}
          </p>
          {result.testedAt && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("configTab.lastVerified")}: {new Date(result.testedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
      <X className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-destructive">{t("configTab.connectionFailed")}</p>
        {result.error && (
          <p className="text-xs text-destructive/80 mt-0.5 break-words">{result.error}</p>
        )}
        {result.persisted && result.testedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("configTab.lastVerified")}: {new Date(result.testedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  )
}

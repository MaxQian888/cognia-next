"use client"

/**
 * Tests tab of the mobile remote-session view.
 *
 * Chrome comes from the vendored `components/ai-elements/test-results.tsx`
 * compound API. Every label is passed as `children`: the vendored defaults
 * render hard-coded English ("passed", "tests passed"), and that component is
 * excluded from `lint:i18n`, so relying on them would ship untranslated text
 * that no gate would catch.
 *
 * An `inconclusive` verification renders amber, with no counts and no progress
 * bar. The vendored default would have shown a green "0 passed" badge for it —
 * exactly the silent green that `RunVerificationSummary` exists to prevent.
 */

import { useTranslations } from "next-intl"

import {
  TestResults,
  TestResultsContent,
  TestResultsDuration,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
} from "@/components/ai-elements/test-results"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RunVerificationConclusion } from "@/types/execution/run"
import { useSessionVerifications } from "./use-session-verifications"

const CONCLUSION_TONE: Record<RunVerificationConclusion, string> = {
  passed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  inconclusive: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
}

export interface SessionTestsPanelProps {
  sessionId: string
}

export function SessionTestsPanel({ sessionId }: SessionTestsPanelProps) {
  const t = useTranslations("mobile.remoteSessions.detail.tests")
  const { loading, noRuns, runs } = useSessionVerifications(sessionId)

  if (loading) {
    return (
      <div className="p-3" data-testid="session-tests-panel">
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      </div>
    )
  }

  if (noRuns || runs.length === 0) {
    return (
      <div className="p-3" data-testid="session-tests-panel">
        <p
          className="text-xs text-muted-foreground"
          data-testid={noRuns ? "session-tests-no-runs" : "session-tests-none"}
        >
          {noRuns ? t("noRuns") : t("none")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="session-tests-panel">
      {runs.map((run) => (
        <section key={run.runId} className="flex flex-col gap-2">
          <h3 className="truncate text-[11px] font-medium text-muted-foreground">{run.title}</h3>
          {run.verifications.map((artifact) => {
            const { conclusion, passed, failed, skipped, total, durationMs } = artifact.verification
            const inconclusive = conclusion === "inconclusive"
            const percent = (value: number) => (total > 0 ? (value / total) * 100 : 0)
            return (
              <TestResults
                key={artifact.id}
                data-testid="session-test-result"
                data-conclusion={conclusion}
                summary={{
                  passed,
                  failed,
                  skipped,
                  total,
                  ...(durationMs !== undefined ? { duration: durationMs } : {}),
                }}
              >
                <TestResultsHeader>
                  <TestResultsSummary>
                    <Badge variant="secondary" className={cn("text-[10px]", CONCLUSION_TONE[conclusion])}>
                      {t(`conclusions.${conclusion}`)}
                    </Badge>
                    {inconclusive ? null : (
                      <>
                        <span className="text-[11px] text-muted-foreground">
                          {t("passed", { count: passed })}
                        </span>
                        {failed > 0 ? (
                          <span className="text-[11px] text-red-600 dark:text-red-400">
                            {t("failed", { count: failed })}
                          </span>
                        ) : null}
                        {skipped > 0 ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t("skipped", { count: skipped })}
                          </span>
                        ) : null}
                      </>
                    )}
                  </TestResultsSummary>
                  <TestResultsDuration />
                </TestResultsHeader>

                <TestResultsContent>
                  {inconclusive ? (
                    <p className="text-[11px] text-muted-foreground" data-testid="session-test-inconclusive">
                      {t("inconclusiveNote")}
                    </p>
                  ) : total > 0 ? (
                    <TestResultsProgress>
                      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                        <div className="bg-emerald-500" style={{ width: `${percent(passed)}%` }} />
                        <div className="bg-red-500" style={{ width: `${percent(failed)}%` }} />
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {t("progress", { passed, total })}
                      </p>
                    </TestResultsProgress>
                  ) : null}
                </TestResultsContent>
              </TestResults>
            )
          })}
        </section>
      ))}
    </div>
  )
}

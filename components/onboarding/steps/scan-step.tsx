"use client"

import {
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  MessagesSquareIcon,
  RefreshCwIcon,
  SearchXIcon,
} from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import type { OnboardingShell } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { StepHeading } from "../step-shell"
import type { HistoryImport } from "@/hooks/onboarding/use-history-import"
import type { MachineScan } from "@/hooks/onboarding/use-machine-scan"
import type { MigrationVendor } from "@/lib/agent-migration/types"

interface ScanStepProps {
  shell: OnboardingShell
  scan: MachineScan
  /** Conversations found on this machine, across every session source. */
  history: HistoryImport
  /** Runs the ADR-0107 preview → apply for one vendor, inline. */
  onImport: (vendor: MigrationVendor) => Promise<void>
  /** Brings every discovered conversation across. */
  onImportHistory: () => Promise<void>
  /** Paired phones hand off to the existing pairing route. */
  onOpenPairing?: () => void
}

/**
 * Step 1 — what is already on this machine, and what is worth bringing over.
 *
 * This is the step that pays for the whole flow existing. Cognia already knew
 * how to detect an installed `claude-code` and import its commands, settings
 * and past sessions (ADR-0107) — but only from Settings → Data, which a
 * first-run user has no reason to open. "We found Claude Code, want your setup
 * moved across?" is a categorically better opening than "choose a sign-in
 * method".
 *
 * On a paired phone the same step exists but its body is pairing: there is no
 * local runtime to find, because the compute lives on the desktop.
 */
export function ScanStep({
  shell,
  scan,
  history,
  onImport,
  onImportHistory,
  onOpenPairing,
}: ScanStepProps) {
  const t = useTranslations("onboarding")
  const [importing, setImporting] = useState<MigrationVendor | null>(null)
  const [done, setDone] = useState<MigrationVendor[]>([])
  const [failed, setFailed] = useState<MigrationVendor[]>([])

  if (shell === "mobile-paired") {
    return (
      <div className="flex flex-col gap-6" data-testid="onboarding-scan-paired">
        <StepHeading title={t("scan.pairedTitle")} description={t("scan.pairedDescription")} />
        <Button onClick={onOpenPairing} data-testid="onboarding-open-pairing">
          {t("scan.pairedCta")}
        </Button>
      </div>
    )
  }

  const runImport = async (vendor: MigrationVendor) => {
    if (importing) return
    setImporting(vendor)
    try {
      await onImport(vendor)
      setDone((d) => [...d, vendor])
    } catch {
      // Surfaced inline rather than thrown: a failed import must not block the
      // user from reaching a first output, which is the point of the flow.
      setFailed((f) => [...f, vendor])
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-scan">
      <StepHeading title={t("scan.title")} description={t("scan.description")} />

      {scan.phase === "scanning" && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="onboarding-scan-scanning"
        >
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          {t("scan.scanning")}
        </div>
      )}

      {scan.phase === "empty" && (
        <div className="flex flex-col gap-3" data-testid="onboarding-scan-empty">
          <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
            <SearchXIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("scan.empty")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("scan.emptyDescription")}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={scan.rescan}
            data-testid="onboarding-scan-rescan"
          >
            <RefreshCwIcon className="size-3.5" />
            {t("scan.rescan")}
          </Button>
        </div>
      )}

      {scan.phase === "found" && (
        <div className="flex flex-col gap-4" data-testid="onboarding-scan-found">
          {scan.result.runtimes.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">
                {t("scan.runtimesFound", { count: scan.result.runtimes.length })}
              </p>
              <ul className="flex flex-col gap-2">
                {scan.result.runtimes.map((rt) => (
                  <li
                    key={rt.id}
                    className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
                    data-testid={`onboarding-runtime-${rt.id}`}
                  >
                    <span className="truncate text-sm">{rt.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {rt.authenticated ? t("scan.authenticated") : t("scan.needsAuth")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {scan.result.migratable.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{t("scan.migrateTitle")}</p>
              <ul className="flex flex-col gap-2">
                {scan.result.migratable.map((probe) => {
                  const isDone = done.includes(probe.vendor)
                  const isFailed = failed.includes(probe.vendor)
                  return (
                    <li
                      key={probe.vendor}
                      className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
                      data-testid={`onboarding-migrate-${probe.vendor}`}
                    >
                      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                        {isFailed
                          ? t("scan.migrateFailed")
                          : t("scan.migrateDescription", { vendor: probe.vendor })}
                      </span>
                      {isDone ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <CheckCircle2Icon className="size-3.5" aria-hidden />
                          {t("scan.migrateDone")}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={importing !== null}
                          onClick={() => void runImport(probe.vendor)}
                          data-testid={`onboarding-migrate-cta-${probe.vendor}`}
                        >
                          {importing === probe.vendor ? (
                            <>
                              <Loader2Icon className="size-3.5 animate-spin" />
                              {t("scan.migrateRunning")}
                            </>
                          ) : (
                            <>
                              <DownloadIcon className="size-3.5" />
                              {t("scan.migrateCta")}
                            </>
                          )}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <ChatHistoryBlock history={history} onImport={onImportHistory} />
    </div>
  )
}

/**
 * "We found N past conversations — want them?"
 *
 * Separate from the migration list above because it is keyed on a different
 * question. That list asks "whose *config* is installed here"; this one asks
 * "whose *transcripts* are on this disk", which is answered by the ADR-0062
 * source registry and therefore covers every agent Cognia can read — including
 * the three (Gemini CLI, Continue, Aider) that the config migration has no
 * vendor row for.
 */
function ChatHistoryBlock({
  history,
  onImport,
}: {
  history: HistoryImport
  onImport: () => Promise<void>
}) {
  const t = useTranslations("onboarding")
  const [busy, setBusy] = useState(false)

  // Nothing to say while the walk is still running on a step that already has
  // a spinner of its own, and nothing to say when the disk is clean.
  if (history.phase === "idle" || history.phase === "empty") return null
  if (history.phase === "scanning") {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="onboarding-history-scanning"
      >
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {t("scan.historyScanning")}
      </div>
    )
  }

  const running = busy || history.phase === "importing"
  const done = history.phase === "done"

  return (
    <div className="flex flex-col gap-2" data-testid="onboarding-history">
      <p className="text-sm font-medium">{t("scan.historyTitle")}</p>
      <div className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3">
        <MessagesSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {done
              ? t("scan.historyImported", { count: history.imported })
              : t("scan.historyFound", { count: history.total })}
          </p>
          {!done && history.sources.length > 0 && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {history.sources.map((s) => `${s.label} (${s.sessions})`).join(" · ")}
            </p>
          )}
          {history.partial && !done && (
            <p className="mt-1 text-xs text-muted-foreground">{t("scan.historyPartial")}</p>
          )}
        </div>
        {done ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3.5" aria-hidden />
            {t("scan.migrateDone")}
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={running}
            onClick={() => {
              setBusy(true)
              // `Promise.resolve` rather than `onImport().finally`: the local
              // busy flag must survive a handler that returns void.
              void Promise.resolve(onImport()).finally(() => setBusy(false))
            }}
            data-testid="onboarding-history-cta"
          >
            {running ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" />
                {t("scan.historyImporting", { percent: Math.round(history.progress * 100) })}
              </>
            ) : (
              <>
                <DownloadIcon className="size-3.5" />
                {t("scan.historyCta")}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

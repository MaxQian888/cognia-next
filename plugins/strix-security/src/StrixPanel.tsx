"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ShieldAlert } from "lucide-react"
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@cognia/plugin-ui"
import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import { useElementWidth } from "@cognia/plugin-sdk/api/context-panel"
import { toSarifLog } from "@cognia/plugin-sdk/api/security-findings"
import { downloadBlob } from "@cognia/plugin-sdk"
import type {
  FindingState,
  FindingStateRow,
  PreflightStatus,
  ScanOptions,
  StrixFinding,
  StrixRun,
  SuppressionRule,
} from "./types"
import { PANEL_ID } from "./ids"
import {
  clearActiveScan,
  consumePendingTarget,
  getActiveScan,
  peekStrixRuntime,
  setActiveScan,
} from "./runtime"
import { usePluginT } from "./use-plugin-t"
import {
  addSuppressionRule,
  clearAllRuns,
  removeSuppressionRule,
  deleteRun,
  getPref,
  listFindingStates,
  listFindings,
  listRuns,
  listSuppressionRules,
  setFindingState,
  setPref,
  suppressionRuleId,
} from "./db"
import { sortBySeverity } from "./lib/parse-reports"
import { suppressedFingerprints, toScanReport } from "./lib/triage"
import { runPreflight } from "./lib/preflight"
import { purgeAllArtifacts, purgeRunArtifacts, runScan } from "./lib/strix-runner"
import { securityScanExecutionRunId } from "@cognia/plugin-sdk/api/security-findings"
import { PreflightBanner } from "./components/preflight-banner"
import { ScanForm } from "./components/scan-form"
import { ScanConsole } from "./components/scan-console"
import { FindingsList } from "./components/findings-list"
import { RunStatusBanner } from "./components/run-status-banner"
import { ScanHistory } from "./components/scan-history"

// Shared empty results: `useLiveQuery(...) ?? []` would mint a new array on
// every render where the query has not resolved, changing the identity of
// every callback that depends on it.
const NO_RUNS: StrixRun[] = []
const NO_FINDINGS: StrixFinding[] = []
const NO_STATES: FindingStateRow[] = []
const NO_RULES: SuppressionRule[] = []

/**
 * The console keeps only the tail of a scan's output. A long scan streams
 * megabytes; React re-renders on every chunk, so the string must stay bounded
 * or the panel crawls. 200KB is ~3k lines of output — far past the point where
 * the head of the stream is still interesting.
 */
const MAX_CONSOLE_CHARS = 200 * 1024

/**
 * Findings render in two columns once the panel is docked wide enough for a
 * card to stay readable in half the space.
 */
const WIDE_FINDINGS_PX = 880

const uuid = () => crypto.randomUUID()
const now = () => Date.now()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Tab = "scan" | "history"

export function StrixPanel(_props: ContextPanelRenderProps) {
  const t = usePluginT()
  const rt = peekStrixRuntime()

  const [tab, setTab] = useState<Tab>("scan")
  const [preflight, setPreflight] = useState<PreflightStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [consoleOut, setConsoleOut] = useState<{ text: string; truncated: boolean }>({
    text: "",
    truncated: false,
  })
  const [scanning, setScanning] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  // `loaded` gates the form's first render: its fields initialize from these
  // values via useState, so mounting before prefs resolve would lock in the
  // empty defaults forever.
  const [prefs, setPrefs] = useState<{ loaded: boolean; target?: string; model?: string }>({
    loaded: false,
  })
  const abortRef = useRef<AbortController | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelWidth = useElementWidth(rootRef)

  const dexie = rt?.dexie ?? null
  const terminal = rt?.terminal ?? null
  const securityScans = rt?.securityScans ?? null

  const runsQuery = useLiveQuery(() => (dexie ? listRuns(dexie) : Promise.resolve([])), [dexie])
  const runs = runsQuery ?? NO_RUNS
  const findings =
    useLiveQuery(
      async () =>
        dexie && selectedRunId ? sortBySeverity(await listFindings(dexie, selectedRunId)) : [],
      [dexie, selectedRunId]
    ) ?? NO_FINDINGS

  // Triage is stored per TARGET, so it is loaded from the selected run's
  // target rather than the run id — a verdict recorded on one scan applies to
  // the next scan of the same system, which is the whole point of a stable
  // fingerprint.
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null
  const target = selectedRun?.target ?? ""
  const states =
    useLiveQuery(
      () => (dexie && target ? listFindingStates(dexie, target) : Promise.resolve([])),
      [dexie, target]
    ) ?? NO_STATES
  const rules =
    useLiveQuery(
      () => (dexie && target ? listSuppressionRules(dexie, target) : Promise.resolve([])),
      [dexie, target]
    ) ?? NO_RULES

  // A scan row survives this panel's unmount: the PTY keeps streaming into
  // Dexie whether or not anyone is looking. Deriving "scanning" from the row
  // (not only local state) is what lets a remounted panel still offer Cancel.
  const liveRunning = runs.find((run) => run.status === "running") ?? null
  const isScanning = scanning || Boolean(liveRunning)

  const onStateChange = useCallback(
    (finding: StrixFinding, state: FindingState) => {
      if (!dexie || !target || !finding.fingerprint) return
      void setFindingState(dexie, {
        target,
        fingerprint: finding.fingerprint,
        state,
        now: now(),
      })
    },
    [dexie, target]
  )

  const onSuppressRule = useCallback(
    (finding: StrixFinding) => {
      if (!dexie || !target || !finding.ruleId) return
      void addSuppressionRule(dexie, { target, ruleId: finding.ruleId, now: now() })
    },
    [dexie, target]
  )

  const onUnsuppressRule = useCallback(
    (finding: StrixFinding) => {
      if (!dexie || !target || !finding.ruleId) return
      void removeSuppressionRule(dexie, suppressionRuleId(target, finding.ruleId))
    },
    [dexie, target]
  )

  /**
   * Export the selected run as SARIF 2.1.0.
   *
   * Suppressed findings are omitted from the log and the report carries the
   * run's own completeness, so an unreadable scan exports with
   * `executionSuccessful: false` rather than as a clean result. Proof-of-concept
   * code never reaches the file — `toScanReport` drops it.
   */
  const onExport = useCallback(() => {
    if (!selectedRun) return
    const report = toScanReport(selectedRun, findings)
    const log = toSarifLog(report, {
      suppressed: suppressedFingerprints(findings, { states, rules }),
    })
    downloadBlob(
      `cognia-security-${selectedRun.runId}.sarif`,
      new Blob([JSON.stringify(log, null, 2)], { type: "application/sarif+json" })
    )
  }, [selectedRun, findings, states, rules])

  const check = useCallback(async () => {
    if (!terminal) return
    setChecking(true)
    try {
      setPreflight(await runPreflight(terminal, { sleep, now, randomId: uuid, pollMs: 400 }))
    } catch {
      setPreflight({ docker: false, strix: false, checkedAt: now() })
    } finally {
      setChecking(false)
    }
  }, [terminal])

  useEffect(() => {
    // Defer so the async check (which flips `checking`) doesn't run as a
    // synchronous set-state in the effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => void check())
  }, [check])

  useEffect(() => {
    // A `/security <target>` dispatch may have arrived while no panel was
    // mounted; the first form to mount consumes the stashed target, which
    // beats the remembered preference.
    const pending = consumePendingTarget()
    let cancelled = false
    void (async () => {
      const [savedTarget, savedModel] = dexie
        ? [await getPref(dexie, "lastTarget"), await getPref(dexie, "lastModel")]
        : [undefined, undefined]
      if (!cancelled) {
        setPrefs({ loaded: true, target: pending ?? savedTarget, model: savedModel })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dexie])

  const onStart = useCallback(
    async (opts: ScanOptions) => {
      if (!terminal || !dexie || !securityScans) return
      setConsoleOut({ text: "", truncated: false })
      const controller = new AbortController()
      let unregisterController: (() => void) | undefined
      abortRef.current = controller
      setScanning(true)
      try {
        await runScan(opts, {
          terminal,
          dexie,
          now,
          randomId: uuid,
          sleep,
          pollMs: 800,
          signal: controller.signal,
          onConsole: (txt) =>
            setConsoleOut((prev) => {
              const next = prev.text + txt
              return next.length > MAX_CONSOLE_CHARS
                ? { text: next.slice(-MAX_CONSOLE_CHARS), truncated: true }
                : { text: next, truncated: prev.truncated }
            }),
          onRun: (r) => {
            setSelectedRunId(r.runId)
            // Module-level handle: a remounted panel (or plugin teardown) can
            // still abort this scan after this component instance is gone.
            if (getActiveScan()?.runId !== r.runId) setActiveScan(r.runId, controller)
            unregisterController ??= securityScans.registerRunController(
              securityScanExecutionRunId(r.runId),
              controller
            )
            // Project the scan onto the canonical run journal so it shows up
            // in the task cockpit alongside every other long-running thing.
            // Best-effort: a projection failure must never take down a scan
            // that is otherwise working.
            void securityScans.syncExecutionRun(r).catch(() => undefined)
            // A terminal transition fires exactly once per run (the final
            // update) — a toast is how the end of a scan reaches a user who
            // is not looking at this panel.
            const ui = peekStrixRuntime()?.ui
            if (r.status === "done") {
              ui?.showToast(t("toast.scanDone", { count: r.findingsCount }), "success")
            } else if (r.status === "error") {
              ui?.showToast(t("toast.scanFailed"), "error")
            } else if (r.status === "cancelled") {
              ui?.showToast(t("toast.scanCancelled"), "info")
            }
          },
        })
        await setPref(dexie, "lastTarget", opts.target)
        await setPref(dexie, "lastModel", opts.model ?? "")
      } finally {
        unregisterController?.()
        clearActiveScan()
        setScanning(false)
        abortRef.current = null
      }
    },
    [terminal, dexie, securityScans, t]
  )

  // Announce a running scan on the panel's own rail button. Without it the
  // only way to learn a scan is still going is to come back and look.
  useEffect(() => {
    rt?.contextPanels?.setBadge(PANEL_ID, isScanning ? 1 : 0)
  }, [rt, isScanning])

  const onCancel = useCallback(() => {
    // This mount's own scan if it has one, else the module-level one — the
    // latter covers a panel remounted while a scan was still running.
    ;(abortRef.current ?? getActiveScan()?.controller)?.abort()
  }, [])

  const onView = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setTab("scan")
  }, [])
  // Deleting must remove the on-disk artifacts too: the scan directory holds
  // `vulnerabilities.json` with full PoC exploits, and clearing only the Dexie
  // rows left them on disk forever with no GC path.
  const onDelete = useCallback(
    (runId: string) => {
      if (!dexie) return
      const run = runs.find((r) => r.runId === runId)
      // Deleting a live run would orphan its PTY and its artifacts.
      if (run?.status === "running") return
      void (async () => {
        const confirmed =
          (await rt?.ui?.showConfirmDialog?.({
            title: t("confirm.deleteRun.title"),
            message: t("confirm.deleteRun.message", { target: run?.target ?? runId }),
            confirmLabel: t("confirm.deleteRun.confirm"),
            variant: "destructive",
          })) ?? true
        if (!confirmed) return
        if (selectedRunId === runId) setSelectedRunId(null)
        if (terminal) {
          await purgeRunArtifacts(runId, { terminal, randomId: uuid, sleep, pollMs: 400 })
        }
        await deleteRun(dexie, runId)
      })()
    },
    [dexie, terminal, rt, t, runs, selectedRunId]
  )
  const onClearAll = useCallback(() => {
    if (!dexie) return
    void (async () => {
      const confirmed =
        (await rt?.ui?.showConfirmDialog?.({
          title: t("confirm.clearAll.title"),
          message: t("confirm.clearAll.message", { count: runs.length }),
          confirmLabel: t("confirm.clearAll.confirm"),
          variant: "destructive",
        })) ?? true
      if (!confirmed) return
      setSelectedRunId(null)
      if (terminal) {
        await purgeAllArtifacts({ terminal, randomId: uuid, sleep, pollMs: 400 })
      }
      await clearAllRuns(dexie)
    })()
  }, [dexie, terminal, rt, t, runs.length])

  if (!rt || !dexie || !terminal) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="strix-unavailable"
      >
        <ShieldAlert className="size-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("preflight.dockerMissing")}</p>
      </div>
    )
  }

  const preflightOk = Boolean(preflight?.docker && preflight?.strix)

  return (
    // No title bar of its own: the Context Workbench draws the panel header
    // (icon + label + width controls). Drawing a second one stacked two
    // identical titles and ate 48px of a 360px column.
    <div ref={rootRef} className="flex h-full flex-col" data-testid="strix-panel">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-3 mt-2 w-fit flex-initial">
          <TabsTrigger value="scan">{t("panel.tab.scan")}</TabsTrigger>
          <TabsTrigger value="history">{t("panel.tab.history")}</TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-3">
            <PreflightBanner status={preflight} checking={checking} onRecheck={check} />
            {prefs.loaded ? (
              <ScanForm
                scanning={isScanning}
                canScan={preflightOk}
                defaultTarget={prefs.target}
                defaultModel={prefs.model}
                onStart={onStart}
                onCancel={onCancel}
              />
            ) : (
              <div className="flex flex-col gap-2" data-testid="strix-form-loading">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}
            <ScanConsole text={consoleOut.text} truncated={consoleOut.truncated} />
            {selectedRun && (
              <>
                <RunStatusBanner run={selectedRun} />
                <FindingsList
                  findings={findings}
                  states={states}
                  rules={rules}
                  columns={panelWidth >= WIDE_FINDINGS_PX ? 2 : 1}
                  onStateChange={onStateChange}
                  onSuppressRule={onSuppressRule}
                  onUnsuppressRule={onUnsuppressRule}
                  onExport={onExport}
                />
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-3">
          <ScanHistory
            runs={runs}
            selectedRunId={selectedRunId}
            onView={onView}
            onDelete={onDelete}
            onClearAll={onClearAll}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

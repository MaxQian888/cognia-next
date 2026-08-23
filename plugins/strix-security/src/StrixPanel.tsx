"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ShieldAlert } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { PluginViewProps } from "@/types/plugin/plugin-view"
import { toSarifLog } from "@cognia/security-findings"
import { downloadBlob } from "@/lib/connectors/audit-export"
import type {
  FindingState,
  FindingStateRow,
  PreflightStatus,
  ScanOptions,
  StrixFinding,
  SuppressionRule,
} from "./types"
import { peekStrixRuntime } from "./runtime"
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
import {
  securityScanExecutionRunId,
  syncSecurityScanExecutionRun,
} from "@/lib/execution/security-scan-bridge"
import { registerSecurityScanRunController } from "@/lib/execution/control-handlers"
import { PreflightBanner } from "./components/preflight-banner"
import { ScanForm } from "./components/scan-form"
import { ScanConsole } from "./components/scan-console"
import { FindingsList } from "./components/findings-list"
import { ScanHistory } from "./components/scan-history"

// Shared empty results: `useLiveQuery(...) ?? []` would mint a new array on
// every render where the query has not resolved, changing the identity of
// every callback that depends on it.
const NO_FINDINGS: StrixFinding[] = []
const NO_STATES: FindingStateRow[] = []
const NO_RULES: SuppressionRule[] = []

const uuid = () => crypto.randomUUID()
const now = () => Date.now()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Tab = "scan" | "history"

export function StrixPanel(_props: PluginViewProps) {
  const t = usePluginT()
  const rt = peekStrixRuntime()

  const [tab, setTab] = useState<Tab>("scan")
  const [preflight, setPreflight] = useState<PreflightStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [consoleText, setConsoleText] = useState("")
  const [scanning, setScanning] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [defaults, setDefaults] = useState<{ target?: string; model?: string }>({})
  const abortRef = useRef<AbortController | null>(null)

  const dexie = rt?.dexie ?? null
  const terminal = rt?.terminal ?? null

  const runs = useLiveQuery(() => (dexie ? listRuns(dexie) : Promise.resolve([])), [dexie]) ?? []
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
    if (!dexie) return
    let cancelled = false
    void (async () => {
      const [target, model] = [
        await getPref(dexie, "lastTarget"),
        await getPref(dexie, "lastModel"),
      ]
      if (!cancelled) setDefaults({ target, model })
    })()
    return () => {
      cancelled = true
    }
  }, [dexie])

  const onStart = useCallback(
    async (opts: ScanOptions) => {
      if (!terminal || !dexie) return
      setConsoleText("")
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
          onConsole: (txt) => setConsoleText((prev) => prev + txt),
          onRun: (r) => {
            setSelectedRunId(r.runId)
            unregisterController ??= registerSecurityScanRunController(
              securityScanExecutionRunId(r.runId),
              controller
            )
            // Project the scan onto the canonical run journal so it shows up
            // in the task cockpit alongside every other long-running thing.
            // Best-effort: a projection failure must never take down a scan
            // that is otherwise working.
            void syncSecurityScanExecutionRun(r).catch(() => undefined)
          },
        })
        await setPref(dexie, "lastTarget", opts.target)
        await setPref(dexie, "lastModel", opts.model ?? "")
      } finally {
        unregisterController?.()
        setScanning(false)
        abortRef.current = null
      }
    },
    [terminal, dexie]
  )

  const onCancel = useCallback(() => abortRef.current?.abort(), [])

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
      void (async () => {
        if (terminal) {
          await purgeRunArtifacts(runId, { terminal, randomId: uuid, sleep, pollMs: 400 })
        }
        await deleteRun(dexie, runId)
      })()
    },
    [dexie, terminal]
  )
  const onClearAll = useCallback(() => {
    if (!dexie) return
    void (async () => {
      if (terminal) {
        await purgeAllArtifacts({ terminal, randomId: uuid, sleep, pollMs: 400 })
      }
      await clearAllRuns(dexie)
    })()
  }, [dexie, terminal])

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
    <div className="flex h-full flex-col" data-testid="strix-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <ShieldAlert className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("panel.title")}</span>
      </div>

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
            <ScanForm
              scanning={scanning}
              canScan={preflightOk}
              defaultTarget={defaults.target}
              defaultModel={defaults.model}
              onStart={onStart}
              onCancel={onCancel}
            />
            <ScanConsole text={consoleText} />
            {selectedRunId && (
              <FindingsList
                findings={findings}
                states={states}
                rules={rules}
                onStateChange={onStateChange}
                onSuppressRule={onSuppressRule}
                onUnsuppressRule={onUnsuppressRule}
                onExport={onExport}
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-3">
          <ScanHistory runs={runs} onView={onView} onDelete={onDelete} onClearAll={onClearAll} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

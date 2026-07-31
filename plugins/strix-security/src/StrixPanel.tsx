"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ShieldAlert } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { PluginViewProps } from "@/types/plugin/plugin-view"
import type { PreflightStatus, ScanOptions } from "./types"
import { peekStrixRuntime } from "./runtime"
import { usePluginT } from "./use-plugin-t"
import { clearAllRuns, deleteRun, getPref, listFindings, listRuns, setPref } from "./db"
import { sortBySeverity } from "./lib/parse-reports"
import { runPreflight } from "./lib/preflight"
import { purgeAllArtifacts, purgeRunArtifacts, runScan } from "./lib/strix-runner"
import { PreflightBanner } from "./components/preflight-banner"
import { ScanForm } from "./components/scan-form"
import { ScanConsole } from "./components/scan-console"
import { FindingsList } from "./components/findings-list"
import { ScanHistory } from "./components/scan-history"

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
    ) ?? []

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
          onRun: (r) => setSelectedRunId(r.runId),
        })
        await setPref(dexie, "lastTarget", opts.target)
        await setPref(dexie, "lastModel", opts.model ?? "")
      } finally {
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
            {selectedRunId && <FindingsList findings={findings} />}
          </div>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-3">
          <ScanHistory runs={runs} onView={onView} onDelete={onDelete} onClearAll={onClearAll} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

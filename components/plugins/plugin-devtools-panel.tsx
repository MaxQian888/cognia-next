"use client"

// Devtools panel exposed at /plugins?tab=devtools.
//
// Six sub-tabs surface the real `lib/plugin/devtools/*` modules:
//   logs       — module-level debugLogs from `dev-tools.ts`
//   bus        — PluginDevServer console messages (Tauri only)
//   hooks      — module-level hookCalls from `dev-tools.ts`
//   profiler   — getPerformanceStats per plugin id
//   hot-reload — usePluginHotReload() driving plugin reload + history
//   inspect    — inspectAllPlugins() snapshot table
//
// The panel is gated on developer mode (NODE_ENV=development OR
// localStorage.cognia.plugins.developerMode === "true"). Every pane is
// SSR-safe — module state is only read inside useEffect.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ActivityIcon,
  BugIcon,
  CodeXmlIcon,
  GaugeIcon,
  GitBranchIcon,
  RadioTowerIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  TerminalSquareIcon,
  Trash2Icon,
  TimerIcon,
  ZapIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  clearDebugLogs,
  clearHookCalls,
  getDebugLogs,
  getHookCalls,
  getPerformanceStats,
  inspectAllPlugins,
} from "@/lib/plugin/devtools/dev-tools"
import { usePluginHotReload } from "@/lib/plugin/devtools/hot-reload.client"
import { listPlugins } from "@/lib/db/plugins"
import { isTauri } from "@/lib/tauri"
import {
  clearAllTriggerAudit,
  getTriggerAuditRevision,
  listAllTriggerAuditEntries,
  subscribeTriggerAuditChanges,
  type TriggerAuditEntry,
} from "@/lib/chat/trigger-audit-ring"
import { useSyncExternalStore } from "react"
import {
  installConsoleTap,
  isConsoleTapInstalled,
  uninstallConsoleTap,
} from "@/lib/plugin/devtools/console-tap"
import { CogniaCliStatusCard } from "./devtools/cognia-cli-status-card"
import { CogniaCliLauncher } from "./devtools/cognia-cli-launcher"
import { migrateDeveloperMode, setDeveloperModeEnabled } from "@/lib/plugin/devtools/developer-mode"

export function PluginDevtoolsPanel() {
  const t = useTranslations("plugins.devtoolsPanel")
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    // Read after mount, not during render: the flag lives in a persisted store
    // that rehydrates on the client, so reading it during SSR/static export
    // would render the gate and then contradict itself on hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllowed(migrateDeveloperMode())
  }, [])

  if (!allowed) {
    return (
      <Card className="p-6 text-center space-y-3">
        <BugIcon className="size-10 mx-auto text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("gateHint")}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDeveloperModeEnabled(true)
            setAllowed(true)
          }}
        >
          {t("enableDeveloperMode")}
        </Button>
      </Card>
    )
  }

  return (
    <Card className="gap-0 overflow-hidden border-border/70 py-0 shadow-sm">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/50">
          <BugIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 className="text-sm font-semibold tracking-tight">{t("title")}</h2>
      </div>

      <Tabs defaultValue="logs" className="min-w-0 gap-0">
        <div className="border-b bg-muted/15 p-2">
          <TabsList
            className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:grid-cols-4 2xl:grid-cols-9"
            data-testid="plugin-devtools-tabs"
          >
            <TabsTrigger value="logs">
              <ActivityIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.logs")}</span>
            </TabsTrigger>
            <TabsTrigger value="bus">
              <RadioTowerIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.bus")}</span>
            </TabsTrigger>
            <TabsTrigger value="hooks">
              <GitBranchIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.hooks")}</span>
            </TabsTrigger>
            <TabsTrigger value="profiler">
              <GaugeIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.profiler")}</span>
            </TabsTrigger>
            <TabsTrigger value="hotReload">
              <RotateCcwIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.hotReload")}</span>
            </TabsTrigger>
            <TabsTrigger value="inspect">
              <ScanSearchIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.inspect")}</span>
            </TabsTrigger>
            <TabsTrigger value="lifecycle">
              <GitBranchIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.lifecycle")}</span>
            </TabsTrigger>
            <TabsTrigger value="triggers">
              <CodeXmlIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.triggers")}</span>
            </TabsTrigger>
            <TabsTrigger value="cli">
              <TerminalSquareIcon aria-hidden="true" />
              <span className="truncate">{t("tabs.cli")}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="min-w-0 p-3 md:p-4">
          <TabsContent value="logs" className="mt-0 min-w-0">
            <LogsPane />
          </TabsContent>
          <TabsContent value="bus" className="mt-0 min-w-0">
            <BusPane />
          </TabsContent>
          <TabsContent value="hooks" className="mt-0 min-w-0">
            <HookHistoryPane />
          </TabsContent>
          <TabsContent value="profiler" className="mt-0 min-w-0">
            <ProfilerPane />
          </TabsContent>
          <TabsContent value="hotReload" className="mt-0 min-w-0">
            <HotReloadPane />
          </TabsContent>
          <TabsContent value="inspect" className="mt-0 min-w-0">
            <InspectPane />
          </TabsContent>
          <TabsContent value="lifecycle" className="mt-0 min-w-0">
            <LifecyclePane />
          </TabsContent>
          <TabsContent value="triggers" className="mt-0 min-w-0">
            <TriggersPane />
          </TabsContent>
          <TabsContent value="cli" className="mt-0 min-w-0">
            <div className="space-y-3">
              <CogniaCliStatusCard />
              <CogniaCliLauncher />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </Card>
  )
}

export function LifecyclePane() {
  const t = useTranslations("plugins.devtoolsPanel.lifecycle")
  const [snapshots, setSnapshots] = useState<
    import("@/lib/plugin/core/lifecycle-coordinator").PluginLifecycleCoordinatorSnapshot[]
  >([])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    void import("@/lib/plugin/core/manager").then(({ getPluginManager }) => {
      try {
        const manager = getPluginManager()
        setSnapshots(manager.getPluginLifecycleSnapshots())
        unsubscribe = manager.subscribePluginLifecycleSnapshots((next) => setSnapshots([...next]))
      } catch {
        setSnapshots([])
      }
    })
    return () => unsubscribe?.()
  }, [])

  if (snapshots.length === 0) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</Card>
  }

  return (
    <Card className="p-0">
      <ScrollArea className="max-h-[55vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("plugin")}</TableHead>
              <TableHead>{t("state")}</TableHead>
              <TableHead>{t("services")}</TableHead>
              <TableHead>{t("effects")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshots.map((snapshot) => (
              <TableRow key={snapshot.pluginId}>
                <TableCell className="font-mono text-xs">{snapshot.pluginId}</TableCell>
                <TableCell className="text-xs">
                  {`g${snapshot.generation} · ${snapshot.intent} / ${snapshot.actual}`}
                </TableCell>
                <TableCell className="max-w-72 text-xs">
                  {[...snapshot.providedServices, ...snapshot.currentProviders].join(", ") || "—"}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {`${snapshot.effects.active} / ${snapshot.effects.pending} / ${snapshot.effects.failed}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </Card>
  )
}

// Pane components are exported for unit tests so each can be exercised in
// isolation — Radix Tabs swaps in jsdom are unreliable under fireEvent.click.

// ============================================================================
// Logs pane
// ============================================================================

export function LogsPane() {
  const t = useTranslations("plugins.devtoolsPanel.logs")
  const [logs, setLogs] = useState<ReturnType<typeof getDebugLogs>>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    setLogs(getDebugLogs())
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [])

  return (
    <PaneShell
      loading={loading}
      empty={logs.length === 0}
      emptyHint={t("empty")}
      onRefresh={refresh}
      onClear={() => {
        clearDebugLogs()
        refresh()
      }}
    >
      <ul className="divide-y">
        {logs.map((log, idx) => (
          <li key={idx} className="px-3 py-1.5 text-xs flex items-start gap-2">
            <Badge
              variant={
                log.level === "error"
                  ? "destructive"
                  : log.level === "warn"
                    ? "secondary"
                    : "outline"
              }
              className="text-xs uppercase shrink-0"
            >
              {log.level}
            </Badge>
            <code className="font-mono whitespace-pre-wrap break-all flex-1 min-w-0">
              [{log.category}] {log.message}
            </code>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {log.timestamp.toISOString().split("T")[1]?.slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </PaneShell>
  )
}

// ============================================================================
// Bus pane (Tauri-only — backed by PluginDevServer console messages)
// ============================================================================

interface DevServerLike {
  getConsoleMessages: () => Array<{
    level: "debug" | "info" | "warn" | "error"
    pluginId: string
    message: string
    timestamp: number
  }>
}

export function BusPane() {
  const t = useTranslations("plugins.devtoolsPanel.bus")
  const tauri = isTauri()
  const [messages, setMessages] = useState<ReturnType<DevServerLike["getConsoleMessages"]>>([])
  const [loading, setLoading] = useState(tauri)

  const refresh = async () => {
    if (!tauri) return
    setLoading(true)
    try {
      const mod = await import("@/lib/plugin/devtools/dev-server")
      const server = (
        mod as unknown as { getPluginDevServer: () => DevServerLike }
      ).getPluginDevServer()
      setMessages(server.getConsoleMessages())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!tauri) {
    // Browser fallback — install the console-tap once so the host's
    // `console.{log,warn,error}` flow into the Logs ring buffer. The
    // Bus tab itself stays empty here (no native dev-server), but the
    // Logs tab now actually contains data instead of being blank.
    return <BrowserConsoleTapNotice />
  }

  return (
    <PaneShell
      loading={loading}
      empty={messages.length === 0}
      emptyHint={t("empty")}
      onRefresh={() => void refresh()}
    >
      <ul className="divide-y">
        {messages.map((msg, idx) => (
          <li key={idx} className="px-3 py-1.5 text-xs flex items-start gap-2">
            <Badge
              variant={
                msg.level === "error"
                  ? "destructive"
                  : msg.level === "warn"
                    ? "secondary"
                    : "outline"
              }
              className="text-xs uppercase shrink-0"
            >
              {msg.level}
            </Badge>
            <span className="font-mono shrink-0 text-muted-foreground">{msg.pluginId}</span>
            <code className="font-mono whitespace-pre-wrap break-all flex-1 min-w-0">
              {msg.message}
            </code>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {new Date(msg.timestamp).toISOString().split("T")[1]?.slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </PaneShell>
  )
}

// ============================================================================
// Hook history pane
// ============================================================================

export function HookHistoryPane() {
  const t = useTranslations("plugins.devtoolsPanel.hooks")
  const [calls, setCalls] = useState<ReturnType<typeof getHookCalls>>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    setCalls(getHookCalls())
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [])

  return (
    <PaneShell
      loading={loading}
      empty={calls.length === 0}
      emptyHint={t("empty")}
      onRefresh={refresh}
      onClear={() => {
        clearHookCalls()
        refresh()
      }}
    >
      <ul className="divide-y">
        {calls.map((entry, idx) => (
          <li key={idx} className="px-3 py-1.5 text-xs flex items-start gap-2">
            <Badge variant={entry.error ? "destructive" : "outline"} className="text-xs shrink-0">
              {entry.hookName}
            </Badge>
            <span className="font-mono flex-1 truncate">{entry.pluginId}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {entry.duration.toFixed(1)}ms
            </span>
          </li>
        ))}
      </ul>
    </PaneShell>
  )
}

// ============================================================================
// Profiler pane
// ============================================================================

export function ProfilerPane() {
  const t = useTranslations("plugins.devtoolsPanel.profiler")
  const plugins = useLiveQuery(() => listPlugins(), [])
  const pluginRows = useMemo(() => plugins ?? [], [plugins])
  const [pluginId, setPluginId] = useState<string>("")
  const [stats, setStats] = useState<ReturnType<typeof getPerformanceStats> | null>(null)

  // Auto-select the first plugin once the list loads.
  useEffect(() => {
    if (!pluginId && pluginRows.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPluginId(pluginRows[0]!.id)
    }
  }, [pluginRows, pluginId])

  const refresh = () => {
    if (!pluginId) {
      setStats(null)
      return
    }
    setStats(getPerformanceStats(pluginId))
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId])

  const operations = useMemo(() => {
    if (!stats) return []
    return Object.entries(stats.byOperation)
      .map(([op, info]) => ({
        op,
        count: info.count,
        avg: info.avgDuration,
        share:
          stats.averageDuration > 0 ? (info.avgDuration / Math.max(stats.maxDuration, 1)) * 100 : 0,
      }))
      .sort((a, b) => b.avg - a.avg)
  }, [stats])

  if (pluginRows.length === 0) {
    return (
      <Card className="p-6 text-center space-y-2">
        <TimerIcon className="size-8 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyAll")}</p>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Select value={pluginId} onValueChange={setPluginId}>
          <SelectTrigger className="sm:w-72" aria-label={t("selectPlugin")}>
            <SelectValue placeholder={t("selectPlugin")} />
          </SelectTrigger>
          <SelectContent>
            {pluginRows.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={refresh}>
          <RefreshCcwIcon className="size-3.5 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>

      {!stats || stats.totalOperations === 0 ? (
        <Card className="p-6 text-center space-y-2">
          <TimerIcon className="size-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("emptyForPlugin")}</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              icon={ZapIcon}
              label={t("totalOps")}
              value={stats.totalOperations.toLocaleString()}
            />
            <SummaryCard
              icon={TimerIcon}
              label={t("avgDuration")}
              value={`${stats.averageDuration.toFixed(2)}ms`}
            />
            <SummaryCard
              icon={TimerIcon}
              label={t("maxDuration")}
              value={`${stats.maxDuration.toFixed(2)}ms`}
            />
          </div>
          <Card className="p-0">
            <ScrollArea className="max-h-[40vh]">
              <ul className="divide-y">
                {operations.map(({ op, count, avg, share }) => (
                  <li key={op} className="px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <code className="font-mono truncate">{op}</code>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {`${avg.toFixed(2)}ms · ${count}×`}
                      </span>
                    </div>
                    <Progress value={share} aria-label={op} />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </Card>
        </>
      )}
    </div>
  )
}

// ============================================================================
// Hot reload pane
// ============================================================================

export function HotReloadPane() {
  const t = useTranslations("plugins.devtoolsPanel.hotReload")
  const plugins = useLiveQuery(() => listPlugins(), [])
  const pluginRows = plugins ?? []
  const { isWatching, reloadHistory, reloadPlugin, reloadAll } = usePluginHotReload()
  const [busyId, setBusyId] = useState<string | null>(null)

  const handleReload = async (id: string) => {
    setBusyId(id)
    try {
      await reloadPlugin(id)
    } finally {
      setBusyId(null)
    }
  }

  const handleReloadAll = async () => {
    setBusyId("__all__")
    try {
      await reloadAll()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant={isWatching ? "secondary" : "outline"} className="text-xs">
            {isWatching ? t("watching") : t("idle")}
          </Badge>
          <span className="text-muted-foreground">{t("hint")}</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleReloadAll()}
          disabled={busyId !== null || pluginRows.length === 0}
        >
          <RotateCcwIcon className="size-3.5 mr-1.5" />
          {t("reloadAll")}
        </Button>
      </div>

      {pluginRows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("emptyPlugins")}</Card>
      ) : (
        <Card className="p-0">
          <ScrollArea className="max-h-[40vh]">
            <ul className="divide-y">
              {pluginRows.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-medium flex-1 truncate min-w-0">{p.name}</span>
                  <span className="text-muted-foreground shrink-0">v{p.version}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleReload(p.id)}
                    disabled={busyId !== null}
                    aria-label={t("reloadAria", { name: p.name })}
                  >
                    <RotateCcwIcon className="size-3.5 mr-1.5" />
                    {busyId === p.id ? t("reloading") : t("reload")}
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </Card>
      )}

      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-muted-foreground">{t("historyTitle")}</h4>
        {reloadHistory.length === 0 ? (
          <Card className="p-3 text-center text-xs text-muted-foreground">{t("historyEmpty")}</Card>
        ) : (
          <Card className="p-0">
            <ScrollArea className="max-h-[40vh] sm:max-h-[30vh]">
              <ul className="divide-y">
                {reloadHistory
                  .slice()
                  .reverse()
                  .map((entry, idx) => (
                    <li key={idx} className="px-3 py-1.5 text-xs flex items-center gap-2">
                      <Badge
                        variant={entry.success ? "outline" : "destructive"}
                        className="text-xs shrink-0"
                      >
                        {entry.success ? t("ok") : t("failed")}
                      </Badge>
                      <span className="font-mono truncate flex-1">{entry.pluginId}</span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {entry.duration.toFixed(1)}ms
                      </span>
                    </li>
                  ))}
              </ul>
            </ScrollArea>
          </Card>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Inspect pane
// ============================================================================

export function InspectPane() {
  const t = useTranslations("plugins.devtoolsPanel.inspect")
  const [snapshots, setSnapshots] = useState<ReturnType<typeof inspectAllPlugins>>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    setSnapshots(inspectAllPlugins())
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="ghost" onClick={refresh}>
          <RefreshCcwIcon className="size-3.5 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : snapshots.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</Card>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colPlugin")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead className="hidden sm:table-cell text-right">{t("colHooks")}</TableHead>
                <TableHead className="hidden sm:table-cell text-right">{t("colTools")}</TableHead>
                <TableHead className="hidden md:table-cell text-right">
                  {t("colCommands")}
                </TableHead>
                <TableHead className="text-right">{t("colError")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((snap) => (
                <TableRow key={snap.id}>
                  <TableCell className="font-mono text-xs">{snap.id}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {snap.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right text-xs">
                    {snap.registeredHooks.length}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right text-xs">
                    {snap.registeredTools.length}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-right text-xs">
                    {snap.registeredCommands.length}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {snap.lastError ? (
                      <Badge variant="destructive" className="text-xs">
                        {t("error")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Shared shells
// ============================================================================

function PaneShell({
  loading,
  empty,
  emptyHint,
  onRefresh,
  onClear,
  children,
}: {
  loading: boolean
  empty: boolean
  emptyHint: string
  onRefresh: () => void
  onClear?: () => void
  children: React.ReactNode
}) {
  const t = useTranslations("plugins.devtoolsPanel")
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1">
        {onClear && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            <Trash2Icon className="size-3.5 mr-1.5" />
            {t("clear")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          <RefreshCcwIcon className="size-3.5 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>
      <Card className="p-0">
        <ScrollArea className="max-h-[50vh]">
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">…</p>
          ) : empty ? (
            <p className="p-4 text-sm text-muted-foreground text-center">{emptyHint}</p>
          ) : (
            children
          )}
        </ScrollArea>
      </Card>
    </div>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <Card className="p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-xl md:text-2xl font-semibold tabular-nums">{value}</div>
    </Card>
  )
}

/**
 * Browser fallback for the Bus tab — the real PluginDevServer only
 * exists under Tauri. In dev mode we still want plugin authors to see
 * console output, so this panel offers a toggle that installs the
 * `console-tap` (wraps `console.{log,info,warn,error,debug}` and
 * forwards each call into the Logs ring buffer).
 */
function BrowserConsoleTapNotice() {
  const t = useTranslations("plugins.devtoolsPanel.bus")
  const [tapOn, setTapOn] = useState<boolean>(() => isConsoleTapInstalled())
  return (
    <Card className="p-6 text-center space-y-3">
      <BugIcon className="size-8 mx-auto text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("desktopOnly")}</p>
      <p className="text-xs text-muted-foreground">{t("consoleTapHint")}</p>
      <Button
        size="sm"
        variant={tapOn ? "secondary" : "outline"}
        onClick={() => {
          if (tapOn) {
            uninstallConsoleTap()
            setTapOn(false)
          } else {
            installConsoleTap({ pluginId: "browser" })
            setTapOn(true)
          }
        }}
      >
        {tapOn ? t("consoleTapOff") : t("consoleTapOn")}
      </Button>
    </Card>
  )
}

/**
 * Cross-session, cross-plugin view of the trigger audit ring. Plugin
 * authors use this to confirm their `emitTriggerEvent` actually
 * reaches the orchestrator and to spot rejected / errored dispatches.
 */
export function TriggersPane() {
  const t = useTranslations("plugins.triggers.devtools")
  const tStatus = useTranslations("plugins.triggers.status")
  useSyncExternalStore(subscribeTriggerAuditChanges, getTriggerAuditRevision, () => 0)
  const [pluginFilter, setPluginFilter] = useState<string>("all")
  const [kindFilter, setKindFilter] = useState<string>("all")
  const all = listAllTriggerAuditEntries()

  const pluginIds = useMemo(() => {
    const set = new Set<string>()
    for (const e of all) {
      if (e.pluginId) set.add(e.pluginId)
    }
    return Array.from(set).sort()
  }, [all])

  const kinds = useMemo(() => {
    const set = new Set<string>()
    for (const e of all) set.add(e.kind)
    return Array.from(set).sort()
  }, [all])

  const filtered = useMemo(() => {
    return all.filter((e) => {
      if (pluginFilter !== "all" && (e.pluginId ?? "__builtin__") !== pluginFilter) return false
      if (kindFilter !== "all" && e.kind !== kindFilter) return false
      return true
    })
  }, [all, pluginFilter, kindFilter])

  return (
    <Card className="p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pluginFilter} onValueChange={setPluginFilter}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("filterPlugin")}>
            <SelectValue placeholder={t("filterPlugin")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterPluginAll")}</SelectItem>
            <SelectItem value="__builtin__">{t("filterPluginBuiltin")}</SelectItem>
            {pluginIds.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="h-8 w-56 text-xs" aria-label={t("filterKind")}>
            <SelectValue placeholder={t("filterKind")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterKindAll")}</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => clearAllTriggerAudit()}
          className="ml-auto"
        >
          <Trash2Icon className="size-3.5 mr-1" />
          {t("clear")}
        </Button>
      </div>

      <ScrollArea className="max-h-[55vh]">
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">{t("colTime")}</TableHead>
                <TableHead>{t("colPlugin")}</TableHead>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead>{t("colWorkflow")}</TableHead>
                <TableHead className="w-24">{t("colStatus")}</TableHead>
                <TableHead>{t("colError")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((e: TriggerAuditEntry) => (
                <TableRow key={e.id}>
                  <TableCell className="text-[10px] font-mono">
                    {new Date(e.timestamp).toISOString().split("T")[1]?.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-xs">{e.pluginId ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    <code className="font-mono text-[11px]">{e.kind}</code>
                  </TableCell>
                  <TableCell className="text-xs">
                    <code className="font-mono text-[11px]">{e.workflowId}</code>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        e.status === "dispatched"
                          ? "secondary"
                          : e.status === "rejected"
                            ? "outline"
                            : "destructive"
                      }
                      className="text-[10px]"
                    >
                      {tStatus(e.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[10px] text-destructive truncate max-w-xs">
                    {e.errorMessage ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </Card>
  )
}

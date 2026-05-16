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
  BugIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
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
import { ScrollShadowRow } from "./scroll-shadow-row"

const DEVELOPER_MODE_KEY = "cognia.plugins.developerMode"

function isDeveloperMode(): boolean {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
    return true
  }
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(DEVELOPER_MODE_KEY) === "true"
  } catch {
    return false
  }
}

export function PluginDevtoolsPanel() {
  const t = useTranslations("plugins.devtoolsPanel")
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllowed(isDeveloperMode())
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
            if (typeof window !== "undefined") {
              window.localStorage.setItem(DEVELOPER_MODE_KEY, "true")
              setAllowed(true)
            }
          }}
        >
          {t("enableDeveloperMode")}
        </Button>
      </Card>
    )
  }

  return (
    <Tabs defaultValue="logs" className="space-y-3">
      <ScrollShadowRow scrollerClassName="-mx-1 px-1" testId="plugin-devtools-tabs">
        <TabsList className="inline-flex h-9 w-max whitespace-nowrap">
          <TabsTrigger value="logs">{t("tabs.logs")}</TabsTrigger>
          <TabsTrigger value="bus">{t("tabs.bus")}</TabsTrigger>
          <TabsTrigger value="hooks">{t("tabs.hooks")}</TabsTrigger>
          <TabsTrigger value="profiler">{t("tabs.profiler")}</TabsTrigger>
          <TabsTrigger value="hotReload">{t("tabs.hotReload")}</TabsTrigger>
          <TabsTrigger value="inspect">{t("tabs.inspect")}</TabsTrigger>
        </TabsList>
      </ScrollShadowRow>

      <TabsContent value="logs" className="mt-0">
        <LogsPane />
      </TabsContent>
      <TabsContent value="bus" className="mt-0">
        <BusPane />
      </TabsContent>
      <TabsContent value="hooks" className="mt-0">
        <HookHistoryPane />
      </TabsContent>
      <TabsContent value="profiler" className="mt-0">
        <ProfilerPane />
      </TabsContent>
      <TabsContent value="hotReload" className="mt-0">
        <HotReloadPane />
      </TabsContent>
      <TabsContent value="inspect" className="mt-0">
        <InspectPane />
      </TabsContent>
    </Tabs>
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
    return (
      <Card className="p-6 text-center space-y-2">
        <BugIcon className="size-8 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("desktopOnly")}</p>
      </Card>
    )
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
                        {avg.toFixed(2)}ms · {count}×
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
            <ScrollArea className="max-h-[30vh]">
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
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </Card>
  )
}

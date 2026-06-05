"use client"

// Logs sub-tab (python/hybrid plugins only) — live view over the per-plugin
// ring buffer fed by `plugin:python` events (host stderr, pip progress,
// streaming chunks, exits). Subscribes via useSyncExternalStore against
// `lib/plugin/python/log-buffer`; a small runtime strip on top surfaces the
// backend's runtime counters (version, loaded/lazy hosts, calls).

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ScrollTextIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  getPythonLogs,
  clearPythonLogs,
  subscribePythonLogs,
  type PythonLogEntry,
} from "@/lib/plugin/python/log-buffer"
import type { PythonRuntimeInfo } from "@/lib/plugin/core/manager"

function useLiveLogs(pluginId: string): readonly PythonLogEntry[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribePythonLogs((changedId) => {
        if (changedId === pluginId) onStoreChange()
      }),
    [pluginId]
  )
  return useSyncExternalStore(
    subscribe,
    () => getPythonLogs(pluginId),
    () => getPythonLogs(pluginId)
  )
}

/** Best-effort runtime counters; null in web mode / before initialization. */
function useRuntimeInfo(): PythonRuntimeInfo | null {
  const [info, setInfo] = useState<PythonRuntimeInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const runtime = await getPluginManager().getPythonRuntimeInfo()
        if (!cancelled) setInfo(runtime)
      } catch {
        // Manager unavailable (web mode) — strip stays hidden.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return info
}

function entryText(entry: PythonLogEntry, t: ReturnType<typeof useTranslations>): string {
  const data = (entry.data ?? {}) as Record<string, unknown>
  switch (entry.kind) {
    case "log":
      return typeof data.line === "string" ? data.line : JSON.stringify(entry.data)
    case "progress": {
      const phase = typeof data.phase === "string" ? `[${data.phase}] ` : ""
      const message = typeof data.message === "string" ? data.message : ""
      const pct = typeof data.pct === "number" ? ` (${data.pct}%)` : ""
      return `${phase}${message}${pct}`.trim() || JSON.stringify(entry.data)
    }
    case "chunk":
      return typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)
    case "chunk_end":
      return t("streamEnd")
    case "exit":
      return t("exited")
    default:
      return JSON.stringify(entry.data)
  }
}

const KIND_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  log: "secondary",
  progress: "default",
  chunk: "outline",
  chunk_end: "outline",
  exit: "destructive",
}

export function PluginDetailLogs({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail.logs")
  const logs = useLiveLogs(pluginId)
  const runtime = useRuntimeInfo()

  return (
    <div className="space-y-3" data-testid="plugin-detail-logs">
      <div className="flex items-center justify-between gap-2">
        {runtime ? (
          <p className="text-xs text-muted-foreground" data-testid="python-runtime-strip">
            {t("runtimeStrip", {
              version: runtime.version ?? "—",
              plugins: runtime.plugin_count,
              lazy: runtime.lazy_hosts,
              calls: runtime.total_calls,
            })}
          </p>
        ) : (
          <span />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => clearPythonLogs(pluginId)}
          disabled={logs.length === 0}
        >
          <Trash2Icon className="size-3.5" />
          {t("clear")}
        </Button>
      </div>

      {logs.length === 0 ? (
        <Card className="p-6 text-center space-y-2">
          <ScrollTextIcon className="size-10 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </Card>
      ) : (
        <Card className="p-0">
          <ul role="log" aria-label={t("aria")} className="max-h-[55vh] overflow-y-auto p-2">
            {logs.map((entry, index) => (
              <li
                key={`${entry.ts}-${index}`}
                className="flex items-start gap-2 px-2 py-1 text-xs font-mono"
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                <Badge
                  variant={KIND_VARIANT[entry.kind] ?? "outline"}
                  className="shrink-0 px-1 py-0 text-[10px]"
                >
                  {entry.kind}
                </Badge>
                <span className="break-all whitespace-pre-wrap">{entryText(entry, t)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

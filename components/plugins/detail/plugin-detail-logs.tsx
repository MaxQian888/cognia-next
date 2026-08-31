"use client"

// Logs sub-tab. Live view over `lib/plugin/devtools/runtime-log-stream`, the
// same merged reader the DevTools Dev Session workbench uses, so a plugin's
// output does not read differently depending on which screen you opened.
//
// It used to read `lib/plugin/python/log-buffer` directly and was gated to
// python/hybrid. A hybrid plugin therefore showed only half of what it
// emitted, and the frontend half was reachable solely from the workbench,
// behind a verified-activation gate.
//
// The Python runtime counters strip stays conditional: it describes the
// Python host, not the plugin.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ScrollTextIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  clearPluginRuntimeLogs,
  getPluginRuntimeLogs,
  subscribePluginRuntimeLogs,
  type PluginRuntimeLogEntry,
} from "@/lib/plugin/devtools/runtime-log-stream"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PythonRuntimeInfo } from "@/lib/plugin/core/manager"

/**
 * Bumped on every write either source makes, so `useSyncExternalStore` has a
 * primitive snapshot to compare.
 */
let logRevision = 0

function useLiveLogs(pluginId: string): readonly PluginRuntimeLogEntry[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribePluginRuntimeLogs(pluginId, () => {
        logRevision += 1
        onStoreChange()
      }),
    [pluginId]
  )
  // `getPluginRuntimeLogs` merges and sorts on every call, so it cannot be the
  // snapshot itself: `useSyncExternalStore` compares by reference and would
  // loop. The revision counter changes only when a source actually writes.
  const revision = useSyncExternalStore(
    subscribe,
    () => logRevision,
    () => logRevision
  )
  return useMemo(
    () => getPluginRuntimeLogs(pluginId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginId, revision]
  )
}

/** Best-effort runtime counters; null in web mode / before initialization. */
function useRuntimeInfo(enabled: boolean): PythonRuntimeInfo | null {
  const [info, setInfo] = useState<PythonRuntimeInfo | null>(null)
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])
  return info
}

/**
 * The two python frames that carry no text of their own still need a line, or
 * a stream that ended and a host that exited both render as blank rows.
 */
function entryText(entry: PluginRuntimeLogEntry, t: ReturnType<typeof useTranslations>): string {
  if (entry.kind === "chunk_end") return t("streamEnd")
  if (entry.kind === "exit") return t("exited")
  return entry.message
}

const LEVEL_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  debug: "outline",
  info: "secondary",
  warn: "default",
  error: "destructive",
}

export function PluginDetailLogs({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail.logs")
  const logs = useLiveLogs(pluginId)
  const pluginType = usePluginStore((state) => state.plugins[pluginId]?.manifest.type)
  const hasPythonHost = pluginType === "python" || pluginType === "hybrid"
  const runtime = useRuntimeInfo(hasPythonHost)

  return (
    <div className="space-y-3" data-testid="plugin-detail-logs">
      <div className="flex items-center justify-between gap-2">
        {hasPythonHost && runtime ? (
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
          onClick={() => clearPluginRuntimeLogs(pluginId)}
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
            {logs.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-2 px-2 py-1 text-xs font-mono"
                data-runtime={entry.runtime}
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <Badge
                  variant={LEVEL_VARIANT[entry.level] ?? "outline"}
                  className="shrink-0 px-1 py-0 text-[10px]"
                >
                  {entry.level}
                </Badge>
                {/* Which host emitted it. A hybrid plugin emits from two. */}
                <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                  {entry.runtime}
                </span>
                <span className="break-all whitespace-pre-wrap">{entryText(entry, t)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

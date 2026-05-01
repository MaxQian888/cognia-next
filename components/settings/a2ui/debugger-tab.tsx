"use client"

// A2UI Debugger tab — live event stream pulled from `globalEventEmitter`
// (in-memory) plus persisted history from the Dexie `a2uiEventHistory`
// table. Filters by surfaceId / event type, with detail JSON inspector.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { TrashIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { listEvents, clearEvents, appendEvent } from "@/lib/db/a2ui-event-history"
import { globalEventEmitter } from "@/lib/a2ui/events"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIEventHistoryRow } from "@/lib/db/a2ui-types"

type FilterType = "all" | "userAction" | "dataModelChange"

export function DebuggerTab() {
  const t = useTranslations("settings.a2ui.debugger")
  const [rows, setRows] = useState<A2UIEventHistoryRow[]>([])
  const [surfaceFilter, setSurfaceFilter] = useState<string>("__all__")
  const [typeFilter, setTypeFilter] = useState<FilterType>("all")
  const [selected, setSelected] = useState<A2UIEventHistoryRow | null>(null)
  const surfaces = useA2UIStore((s) => s.surfaces)

  const refresh = async () => {
    const all = await listEvents({ limit: 500 })
    setRows(all)
  }

  // Live subscription: append events to the buffer and persist to Dexie.
  useEffect(() => {
    let cancelled = false
    listEvents({ limit: 500 }).then((all) => {
      if (!cancelled) setRows(all)
    })
    const unsubAction = globalEventEmitter.onAction((action) => {
      const row: A2UIEventHistoryRow = {
        id: `evt-${action.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        surfaceId: action.surfaceId,
        type: "userAction",
        payload: { action: action.action, componentId: action.componentId, data: action.data },
        timestamp: action.timestamp,
      }
      void appendEvent(row)
      setRows((prev) => [row, ...prev].slice(0, 500))
    })
    const unsubData = globalEventEmitter.onDataChange((change) => {
      const row: A2UIEventHistoryRow = {
        id: `evt-${change.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        surfaceId: change.surfaceId,
        type: "dataModelChange",
        payload: { path: change.path, value: change.value },
        timestamp: change.timestamp,
      }
      void appendEvent(row)
      setRows((prev) => [row, ...prev].slice(0, 500))
    })
    return () => {
      cancelled = true
      unsubAction()
      unsubData()
    }
  }, [])

  const surfaceIds = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((r) => set.add(r.surfaceId))
    Object.keys(surfaces).forEach((id) => set.add(id))
    return Array.from(set).sort()
  }, [rows, surfaces])

  const filtered = rows.filter((r) => {
    if (surfaceFilter !== "__all__" && r.surfaceId !== surfaceFilter) return false
    if (typeFilter !== "all" && r.type !== typeFilter) return false
    return true
  })

  const onClear = async () => {
    if (!confirm(t("confirmClear"))) return
    const n = await clearEvents()
    setRows([])
    setSelected(null)
    if (n > 0) {
      // user feedback via toast omitted for brevity — count shown in title
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                {t("title")} <Badge variant="secondary">{filtered.length}</Badge>
              </CardTitle>
              <CardDescription>{t("description")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                <RefreshCwIcon className="mr-1 size-3.5" />
                {t("refresh")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void onClear()}>
                <TrashIcon className="mr-1 size-3.5" />
                {t("clear")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={surfaceFilter} onValueChange={setSurfaceFilter}>
              <SelectTrigger className="w-72">
                <SelectValue placeholder={t("filterSurface")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("allSurfaces")}</SelectItem>
                {surfaceIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as FilterType)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allTypes")}</SelectItem>
                <SelectItem value="userAction">userAction</SelectItem>
                <SelectItem value="dataModelChange">dataModelChange</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ScrollArea className="h-72 rounded-md border">
              <div className="divide-y">
                {filtered.length === 0 ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">{t("empty")}</p>
                ) : (
                  filtered.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelected(r)}
                      className={`block w-full text-left px-3 py-2 text-xs hover:bg-accent ${
                        selected?.id === r.id ? "bg-accent" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono">{r.surfaceId}</span>
                        <Badge
                          variant={r.type === "userAction" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {r.type}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between text-muted-foreground">
                        <span className="truncate">
                          {r.type === "userAction"
                            ? String(r.payload.action ?? "")
                            : String(r.payload.path ?? "")}
                        </span>
                        <span className="ml-2 font-mono text-[10px]">
                          {new Date(r.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>

            <ScrollArea className="h-72 rounded-md border">
              {selected ? (
                <pre className="p-3 text-xs font-mono leading-snug whitespace-pre-wrap break-all">
                  {JSON.stringify(selected, null, 2)}
                </pre>
              ) : (
                <p className="p-4 text-center text-sm text-muted-foreground">{t("selectHint")}</p>
              )}
            </ScrollArea>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

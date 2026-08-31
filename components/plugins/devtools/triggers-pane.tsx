"use client"

/**
 * Cross-session, cross-plugin view of the trigger audit ring. Plugin authors
 * use it to confirm their `emitTriggerEvent` actually reaches the orchestrator
 * and to spot rejected or errored dispatches.
 *
 * Extracted from the retired 9-tab `plugin-devtools-panel.tsx`, which had no
 * production mount. Its i18n stays under `plugins.triggers.*`, owned by the
 * trigger subsystem rather than by the panel it used to live in.
 *
 * The ring is module state, so the pane subscribes through
 * `useSyncExternalStore` against a revision counter rather than copying
 * entries into React state on every dispatch.
 */

import { useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  clearAllTriggerAudit,
  getTriggerAuditRevision,
  listAllTriggerAuditEntries,
  subscribeTriggerAuditChanges,
  type TriggerAuditEntry,
} from "@/lib/chat/trigger-audit-ring"

/** Sentinel for entries a built-in trigger produced, which carry no plugin id. */
export const BUILTIN_TRIGGER_FILTER = "__builtin__"
export const ALL_TRIGGER_FILTER = "all"

/**
 * Pure so it can be pinned without driving the two Radix selects, which do not
 * open reliably under jsdom.
 */
export function filterTriggerAuditEntries(
  entries: readonly TriggerAuditEntry[],
  pluginFilter: string,
  kindFilter: string
): TriggerAuditEntry[] {
  return entries.filter((entry) => {
    if (
      pluginFilter !== ALL_TRIGGER_FILTER &&
      (entry.pluginId ?? BUILTIN_TRIGGER_FILTER) !== pluginFilter
    ) {
      return false
    }
    return kindFilter === ALL_TRIGGER_FILTER || entry.kind === kindFilter
  })
}

export function TriggersPane() {
  const t = useTranslations("plugins.triggers.devtools")
  const tStatus = useTranslations("plugins.triggers.status")
  useSyncExternalStore(subscribeTriggerAuditChanges, getTriggerAuditRevision, () => 0)
  const [pluginFilter, setPluginFilter] = useState<string>(ALL_TRIGGER_FILTER)
  const [kindFilter, setKindFilter] = useState<string>(ALL_TRIGGER_FILTER)
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

  const filtered = useMemo(
    () => filterTriggerAuditEntries(all, pluginFilter, kindFilter),
    [all, pluginFilter, kindFilter]
  )

  return (
    <Card className="space-y-3 p-3" data-testid="triggers-pane">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pluginFilter} onValueChange={setPluginFilter}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("filterPlugin")}>
            <SelectValue placeholder={t("filterPlugin")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TRIGGER_FILTER}>{t("filterPluginAll")}</SelectItem>
            <SelectItem value={BUILTIN_TRIGGER_FILTER}>{t("filterPluginBuiltin")}</SelectItem>
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
            <SelectItem value={ALL_TRIGGER_FILTER}>{t("filterKindAll")}</SelectItem>
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
          <Trash2Icon className="mr-1 size-3.5" />
          {t("clear")}
        </Button>
      </div>

      <ScrollArea className="max-h-[55vh]">
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground" data-testid="triggers-empty">
            {t("empty")}
          </p>
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
                  <TableCell className="font-mono text-[10px]">
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
                  <TableCell className="max-w-xs truncate text-[10px] text-destructive">
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

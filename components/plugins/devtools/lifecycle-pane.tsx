"use client"

/**
 * Per-plugin lifecycle readout: generation, intent vs actual state, the
 * services a plugin provides, and its effect counts.
 *
 * Extracted from the retired 9-tab `plugin-devtools-panel.tsx`. That panel had
 * no production mount, so this pane and `triggers-pane.tsx` were the only two
 * parts of it still reachable, through `PluginDevSessionWorkbench`.
 *
 * The manager is imported lazily inside the effect: it pulls in the whole
 * plugin runtime, and this pane sits behind a tab most sessions never open.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { PluginLifecycleCoordinatorSnapshot } from "@/lib/plugin/core/lifecycle-coordinator"

export function LifecyclePane() {
  const t = useTranslations("plugins.devtools.lifecycle")
  const [snapshots, setSnapshots] = useState<PluginLifecycleCoordinatorSnapshot[]>([])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    void import("@/lib/plugin/core/manager").then(({ getPluginManager }) => {
      try {
        const manager = getPluginManager()
        setSnapshots(manager.getPluginLifecycleSnapshots())
        unsubscribe = manager.subscribePluginLifecycleSnapshots((next) => setSnapshots([...next]))
      } catch {
        // No manager in this shell (web / Capacitor) or it failed to boot.
        // An empty table reads the same as "nothing has activated yet".
        setSnapshots([])
      }
    })
    return () => unsubscribe?.()
  }, [])

  if (snapshots.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground" data-testid="lifecycle-empty">
        {t("empty")}
      </Card>
    )
  }

  return (
    <Card className="p-0" data-testid="lifecycle-pane">
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

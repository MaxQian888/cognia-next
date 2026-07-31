"use client"

/**
 * Plugin detail → General → Triggers sub-tab.
 *
 * Lists every workflow currently subscribed to one of this plugin's
 * triggers and lets the user toggle a per-(workflow, kind) mute flag.
 * Muted entries skip dispatch in `lib/plugin/bridge/plugin-trigger-dispatch.ts`.
 */

import { useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  isTriggerMuted,
  listPluginTriggers,
  setTriggerMuted,
  subscribePluginTriggerRegistry,
  subscribeTriggerMuteChanges,
} from "@/lib/workflow/triggers/registry"

interface Props {
  pluginId: string
}

interface Subscription {
  kind: string
  workflowId: string
}

// Module-level revision counter — `useSyncExternalStore` requires a
// snapshot function that returns the same reference between change
// notifications. We bump on every registry or mute event so React
// re-runs the memo + render.
let revision = 0
const bump = (): void => {
  revision += 1
}
const snapshotKey = (): number => revision

const subscribeBoth = (notify: () => void): (() => void) => {
  const a = subscribePluginTriggerRegistry(() => {
    bump()
    notify()
  })
  const b = subscribeTriggerMuteChanges(() => {
    bump()
    notify()
  })
  return () => {
    a()
    b()
  }
}

export function PluginTriggersTab({ pluginId }: Props) {
  const t = useTranslations("plugins.triggers.detailSubscriptions")
  const rev = useSyncExternalStore(subscribeBoth, snapshotKey, () => 0)

  const subscriptions = useMemo<Subscription[]>(() => {
    void rev // recompute when the trigger registry mutates (rev is a change tick)
    const out: Subscription[] = []
    for (const reg of listPluginTriggers()) {
      if (reg.pluginId !== pluginId) continue
      for (const instance of reg.instances.values()) {
        out.push({ kind: reg.kind, workflowId: instance.workflowId })
      }
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind))
  }, [pluginId, rev])

  return (
    <Card className="p-3 space-y-3">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("muteHint")}</p>
      </header>
      {subscriptions.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground py-6">{t("empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colKind")}</TableHead>
              <TableHead>{t("colWorkflow")}</TableHead>
              <TableHead className="w-20 text-right">{t("muteToggle")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((sub) => {
              const muted = isTriggerMuted(pluginId, sub.kind, sub.workflowId)
              return (
                <TableRow key={`${sub.kind}::${sub.workflowId}`}>
                  <TableCell>
                    <code className="font-mono text-xs">{sub.kind}</code>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{sub.workflowId}</code>
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={muted}
                      onCheckedChange={(next) =>
                        setTriggerMuted(pluginId, sub.kind, sub.workflowId, next)
                      }
                      aria-label={t("muteToggle")}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

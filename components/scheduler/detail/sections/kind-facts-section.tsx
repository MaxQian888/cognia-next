"use client"

/**
 * The facts only this kind knows (ADR-0179 §1).
 *
 * One `FactList` per kind, with the reads the old per-kind detail panels
 * did: a workflow trigger's row and its workflow, the backup schedule from
 * settings, a plugin job's payload, a connector digest's payload, the
 * outbound queue's breaker, an OS task's platform record. App tasks have no
 * kind facts of their own; everything about them is in the other sections.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { MessageCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { DEFAULT_BACKUP_AUTO_SCHEDULE, type BackupAutoSchedule } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { FactList, FactRow } from "@/components/surface/fact-list"
import { findActiveSessionForConversation } from "@/lib/connectors/session-bindings"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import type { ScheduledTask } from "@/types/scheduler"
import type { SystemTask } from "@/types/scheduler/system-scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import { BackupScheduleDialog } from "../../backup-schedule-dialog"
import { CONNECTOR_QUEUE_SOURCE_ID } from "@/lib/scheduler/sources/connector-source"

export interface KindFactsSectionProps {
  item: UnifiedScheduledItem
  task?: ScheduledTask
  systemTask?: SystemTask
  /** Called after the backup dialog saves, so the page can refresh the item. */
  onBackupScheduled?: () => void
}

/** True when the kind has facts of its own; the caller skips the section otherwise. */
export function kindHasFacts(item: UnifiedScheduledItem): boolean {
  return item.kind !== "app"
}

export function KindFactsSection(props: KindFactsSectionProps) {
  switch (props.item.kind) {
    case "workflow":
      return <WorkflowFacts triggerId={props.item.sourceId} />
    case "backup":
      return <BackupFacts onScheduled={props.onBackupScheduled} />
    case "plugin":
      return <PluginFacts task={props.task} />
    case "connector":
      return props.item.sourceId === CONNECTOR_QUEUE_SOURCE_ID ? (
        <QueueFacts />
      ) : (
        <ConnectorDigestFacts task={props.task} />
      )
    case "system":
      return <SystemFacts systemTask={props.systemTask} />
    default:
      return null
  }
}

function WorkflowFacts({ triggerId }: { triggerId: string }) {
  const t = useTranslations("scheduler")
  const trigger = useLiveQuery(() => getDb().workflowTriggers.get(triggerId), [triggerId])
  const workflow = useLiveQuery(
    async () => (trigger ? getDb().workflows.get(trigger.workflowId) : undefined),
    [trigger?.workflowId]
  )
  if (!trigger) {
    return <p className="text-xs text-muted-foreground">{t("workflowTriggerNotFound")}</p>
  }
  return (
    <FactList>
      <FactRow label={t("workflow")}>{workflow?.name ?? trigger.workflowId}</FactRow>
      <FactRow label={t("triggerKind")}>{trigger.kind}</FactRow>
      {trigger.webhookPath ? (
        <FactRow label={t("webhookPath")} mono>
          {trigger.webhookPath}
        </FactRow>
      ) : null}
      <FactRow label={t("enabled")}>{trigger.enabled ? t("yes") : t("no")}</FactRow>
    </FactList>
  )
}

function BackupFacts({ onScheduled }: { onScheduled?: () => void }) {
  const t = useTranslations("scheduler")
  const [cfg, setCfg] = useState<BackupAutoSchedule | undefined>(undefined)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    getSettings()
      .then((settings) => {
        if (!cancelled) setCfg(settings.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE)
      })
      .catch(() => {
        if (!cancelled) setCfg(DEFAULT_BACKUP_AUTO_SCHEDULE)
      })
    return () => {
      cancelled = true
    }
  }, [generation])

  const resolved = cfg ?? DEFAULT_BACKUP_AUTO_SCHEDULE
  return (
    <div className="space-y-3">
      <FactList>
        <FactRow label={t("enabled")}>{resolved.enabled ? t("yes") : t("no")}</FactRow>
        <FactRow label={t("interval")}>{`${resolved.intervalDays} ${t("days")}`}</FactRow>
        <FactRow label={t("destination")} mono>
          {resolved.dirPath ?? "-"}
        </FactRow>
        <FactRow label={t("retainCount")}>{String(resolved.retainCount ?? 0)}</FactRow>
      </FactList>
      <BackupScheduleDialog
        onScheduled={() => {
          // Re-read the settings the dialog just wrote; the item row will
          // follow through the source's own subscription.
          setGeneration((n) => n + 1)
          onScheduled?.()
        }}
      />
    </div>
  )
}

function PluginFacts({ task }: { task?: ScheduledTask }) {
  const t = useTranslations("scheduler")
  if (!task) return <p className="text-xs text-muted-foreground">{t("pluginJobNotFound")}</p>
  const payload = task.payload as { pluginId?: string; handler?: string; args?: unknown }
  const argsText =
    payload.args && typeof payload.args === "object" ? JSON.stringify(payload.args, null, 2) : null
  return (
    <div className="space-y-3">
      <FactList>
        <FactRow label={t("plugin")} mono>
          {payload.pluginId ?? "-"}
        </FactRow>
        <FactRow label={t("handler")} mono>
          {payload.handler ?? "-"}
        </FactRow>
      </FactList>
      {argsText ? (
        <pre
          className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground"
          data-testid="plugin-args-block"
        >
          {argsText}
        </pre>
      ) : null}
    </div>
  )
}

interface DigestPayload {
  adapterId?: string
  conversationKey?: string
  characterId?: string
  prompt?: string
}

function ConnectorDigestFacts({ task }: { task?: ScheduledTask }) {
  const t = useTranslations("scheduler")
  if (!task) return <p className="text-xs text-muted-foreground">{t("connectorDigestNotFound")}</p>
  const payload = (task.payload ?? {}) as DigestPayload
  const openSourceConversation = async () => {
    if (!payload.conversationKey) return
    const session = await findActiveSessionForConversation(payload.conversationKey)
    if (!session) {
      toast.error(t("sourceConversationMissing"))
      return
    }
    useChatStore.getState().setActiveSession(session.id)
    useUIStore.getState().setSelectedGuild({ kind: "dm" })
  }
  return (
    <div className="space-y-3">
      <FactList>
        <FactRow label={t("adapter")}>{payload.adapterId ?? "-"}</FactRow>
        <FactRow label={t("conversation")}>
          {payload.conversationKey ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-w-0 justify-start gap-1 p-0 text-xs"
              onClick={() => void openSourceConversation()}
              data-testid="digest-open-conversation"
            >
              <MessageCircleIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{payload.conversationKey}</span>
            </Button>
          ) : (
            "-"
          )}
        </FactRow>
        <FactRow label={t("character")}>{payload.characterId ?? "-"}</FactRow>
      </FactList>
      {payload.prompt ? (
        <pre
          className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="digest-prompt-block"
        >
          {payload.prompt}
        </pre>
      ) : null}
    </div>
  )
}

function QueueFacts() {
  const t = useTranslations("scheduler")
  const queueLength = useLiveQuery(() => getDb().outboundQueue.count(), [])
  const breaker = useLiveQuery(async () => {
    const recent = await getDb().connectorAudit.orderBy("at").reverse().limit(50).toArray()
    return {
      lastOpen: recent.find((row) => row.kind === "circuit.opened")?.at,
      lastClose: recent.find((row) => row.kind === "circuit.closed")?.at,
    }
  }, [])
  return (
    <FactList>
      <FactRow label={t("queueLength")}>
        {typeof queueLength === "number" ? String(queueLength) : "…"}
      </FactRow>
      <FactRow label={t("breakerLastOpened")}>
        {breaker?.lastOpen ? new Date(breaker.lastOpen).toLocaleString() : "-"}
      </FactRow>
      <FactRow label={t("breakerLastClosed")}>
        {breaker?.lastClose ? new Date(breaker.lastClose).toLocaleString() : "-"}
      </FactRow>
    </FactList>
  )
}

function formatSystemTrigger(trigger: SystemTask["trigger"]): string {
  switch (trigger.type) {
    case "cron":
      return `cron: ${trigger.expression}`
    case "interval":
      return `interval: ${trigger.seconds}s`
    case "once":
      return `once: ${trigger.run_at}`
    case "on_boot":
      return `on_boot (delay: ${trigger.delay_seconds || 0}s)`
    case "on_logon":
      return `on_logon${trigger.user ? ` (${trigger.user})` : ""}`
    case "on_event":
      return `on_event: ${trigger.source}:${trigger.event_id}`
    default:
      return "-"
  }
}

function formatSystemAction(action: SystemTask["action"]): string {
  switch (action.type) {
    case "execute_script":
      return `script (${action.language})`
    case "run_command":
      return action.command
    case "launch_app":
      return action.path
    default:
      return "-"
  }
}

function SystemFacts({ systemTask }: { systemTask?: SystemTask }) {
  const t = useTranslations("scheduler")
  if (!systemTask) return <p className="text-xs text-muted-foreground">{t("systemTaskNotFound")}</p>
  return (
    <FactList>
      <FactRow label={t("status")}>{systemTask.status}</FactRow>
      <FactRow label={t("systemTriggerType")} mono>
        {formatSystemTrigger(systemTask.trigger)}
      </FactRow>
      <FactRow label={t("systemActionType")} mono>
        {formatSystemAction(systemTask.action)}
      </FactRow>
      <FactRow label={t("systemRunLevel")}>
        {systemTask.run_level === "administrator" ? t("runLevelAdmin") : t("runLevelUser")}
      </FactRow>
      {systemTask.metadata_state ? (
        <FactRow label={t("detail.metadataState")}>{systemTask.metadata_state}</FactRow>
      ) : null}
    </FactList>
  )
}

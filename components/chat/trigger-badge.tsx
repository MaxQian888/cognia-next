"use client"

/**
 * Small pill rendered next to a chat message when one or more workflow
 * triggers fired on its arrival. Data comes from the in-memory
 * `lib/chat/trigger-audit-ring`. The popover lists each subscribed
 * workflow with its last-run status, so the user can tell at a glance
 * which automations the message kicked off.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ZapIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  getTriggerAuditRevision,
  listTriggerAuditEntries,
  subscribeTriggerAuditChanges,
  type TriggerAuditEntry,
} from "@/lib/chat/trigger-audit-ring"

interface Props {
  sessionId: string
  messageId: string
}

export function TriggerBadge({ sessionId, messageId }: Props) {
  const t = useTranslations("plugins.triggers")
  useSyncExternalStore(subscribeTriggerAuditChanges, getTriggerAuditRevision, () => 0)
  const entries = listTriggerAuditEntries({ sessionId, messageId })
  if (entries.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("badge.ariaLabel")}
          className="inline-flex"
          data-testid="trigger-badge"
        >
          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <ZapIcon className="size-3 text-amber-500" />
            {t("badge.label", { count: entries.length })}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-80 p-3 text-xs">
        <p className="mb-2 text-xs font-semibold">{t("badge.popoverTitle")}</p>
        <ul className="space-y-1.5">
          {entries.map((e) => (
            <TriggerRow key={e.id} entry={e} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function TriggerRow({ entry }: { entry: TriggerAuditEntry }) {
  const t = useTranslations("plugins.triggers")
  return (
    <li className="flex flex-col gap-0.5 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <code className="font-mono text-[11px] flex-1 truncate">{entry.kind}</code>
        <Badge
          variant={
            entry.status === "dispatched"
              ? "secondary"
              : entry.status === "rejected"
                ? "outline"
                : "destructive"
          }
          className="text-[10px]"
        >
          {t(`status.${entry.status}`)}
        </Badge>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">
          {t("badge.workflowPrefix")} {entry.workflowId}
        </span>
        {entry.pluginId && (
          <span className="truncate">
            {t("badge.pluginPrefix")} {entry.pluginId}
          </span>
        )}
      </div>
      {entry.errorMessage && <p className="text-[10px] text-destructive">{entry.errorMessage}</p>}
    </li>
  )
}

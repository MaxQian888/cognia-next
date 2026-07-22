"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import {
  continueConnectorInboundJobSafely,
  dismissConnectorInboundJobRecovery,
  retryConnectorInboundJobFromStart,
} from "@/lib/db/connector-inbound-jobs"
import { getBus } from "@/lib/connectors/bus"

interface InboundRecoveryPanelProps {
  conversationKey: string
}

export function InboundRecoveryPanel({ conversationKey }: InboundRecoveryPanelProps) {
  const t = useTranslations("inbox.inboundRecovery")
  const [workingId, setWorkingId] = useState<string>()
  const jobs = useLiveQuery(
    () =>
      getDb()
        .connectorInboundJobs.where("conversationKey")
        .equals(conversationKey)
        .filter((job) => job.status === "recovery_required")
        .toArray(),
    [conversationKey]
  )

  if (!jobs?.length) return null

  const resolve = async (id: string, action: "continue" | "retry" | "dismiss"): Promise<void> => {
    if (action === "retry" && !window.confirm(t("retryWarning"))) return
    setWorkingId(id)
    try {
      const changed =
        action === "continue"
          ? await continueConnectorInboundJobSafely(id)
          : action === "retry"
            ? await retryConnectorInboundJobFromStart(id, { confirmed: true })
            : await dismissConnectorInboundJobRecovery(id)
      if (changed && action !== "dismiss") await getBus().resumeDurableInboundJobs()
    } finally {
      setWorkingId(undefined)
    }
  }

  return (
    <section
      className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3"
      data-testid="inbound-recovery-panel"
      aria-label={t("title")}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <AlertTriangleIcon className="size-4 text-amber-600" />
        {t("title")}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t("description")}</p>
      <div className="space-y-2">
        {jobs.map((job) => (
          <div key={job.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {t("message", {
                id: job.sourceMessageId,
                reason: job.recoveryReason ?? t("unknown"),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "continue")}
            >
              {t("continueSafely")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "retry")}
            >
              {t("retryFromStart")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={workingId === job.id}
              onClick={() => void resolve(job.id, "dismiss")}
            >
              {t("dismiss")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

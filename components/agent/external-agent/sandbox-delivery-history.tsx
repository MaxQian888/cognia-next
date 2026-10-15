"use client"

import { useFormatter, useTranslations } from "next-intl"
import { useSandboxPlacement } from "@/hooks/sandbox/use-sandbox-placement"
import { Badge } from "@/components/ui/badge"

/** Every session remains inspectable, including retries on a shared instance. */
export function SandboxDeliveryHistory({ agentId }: { agentId: string }) {
  const t = useTranslations("externalAgent.delivery")
  const format = useFormatter()
  const { deliveries, deliveryStatus, report } = useSandboxPlacement(agentId)
  if (!deliveries.length && deliveryStatus !== "failed" && !report?.deliveryRecordError) return null
  return (
    <section aria-label={t("title")} className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      {deliveryStatus === "failed" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loadFailed")}
        </p>
      )}
      {report?.deliveryRecordError && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          {t("persistFailed")}
        </p>
      )}
      <ol className="space-y-3">
        {deliveries.map((record) => (
          <li key={record.id} className="space-y-1 border-t pt-3 text-xs first:border-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{record.providerId}</span>
              <Badge variant="outline">{t(`publish.${record.publishState}`)}</Badge>
              <span>{t(`cleanup.${record.cleanupState}`)}</span>
              <time dateTime={new Date(record.createdAt).toISOString()}>
                {format.dateTime(record.createdAt, { dateStyle: "medium", timeStyle: "short" })}
              </time>
            </div>
            <p className="break-all">{t("session", { id: record.id })}</p>
            {record.taskId && <p className="break-all">{t("task", { id: record.taskId })}</p>}
            <p className="break-all">{t("instance", { id: record.instanceId })}</p>
            <p className="break-all">{t("branch", { branch: record.branch })}</p>
            {record.commit && <p className="break-all">{t("commit", { commit: record.commit })}</p>}
            {record.publish.recovery?.bundle && (
              <p className="break-all">{t("bundle", { path: record.publish.recovery.bundle })}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

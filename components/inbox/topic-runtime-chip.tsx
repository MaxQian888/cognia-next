"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon } from "lucide-react"
import { InboxChip } from "./inbox-chip"
import { getDb } from "@/lib/db/schema"
import {
  resolveDeliveryReadiness,
  resolveInboundActivationPolicy,
} from "@/lib/connectors/conversation-admission"
import { connectorRuntimeCapabilitiesForScope } from "@/types/connectors/runtime-capability"

interface TopicRuntimeChipProps {
  adapterId: string
  conversationKey: string
}

export function TopicRuntimeChip({ adapterId, conversationKey }: TopicRuntimeChipProps) {
  const t = useTranslations("inbox.topicRuntime")
  const diagnostic = useLiveQuery(async () => {
    const db = getDb()
    const [adapter, state, override, jobs, bindings] = await Promise.all([
      db.adapterInstances.get(adapterId),
      db.connectorConversationStates.get(conversationKey),
      db.conversationOverrides.where("conversationKey").equals(conversationKey).first(),
      db.connectorInboundJobs.where("conversationKey").equals(conversationKey).toArray(),
      db.executionRunBindings.where("conversationKey").equals(conversationKey).toArray(),
    ])
    if (!adapter) return undefined
    const requested = resolveInboundActivationPolicy(adapter, override)
    const readiness = resolveDeliveryReadiness(state?.deliveryReadiness, adapter.deliveryReadiness)
    const needsVerifiedDelivery =
      adapter.type === "lark" && (requested === "always" || requested === "mention_activates")
    const effective =
      needsVerifiedDelivery && readiness !== "all_messages_verified" ? "mention_each" : requested
    const capabilities = connectorRuntimeCapabilitiesForScope(adapter.type, "thread")
    return {
      requested,
      effective,
      readiness,
      dispatch:
        state?.dispatchMode ??
        override?.activeRunDispatchMode ??
        adapter.activeRunDispatchMode ??
        "queue",
      active:
        state?.activationStatus === "active" &&
        (state.expiresAt === undefined || state.expiresAt > Date.now()),
      queueDepth: jobs.filter((job) => job.status === "queued" || job.status === "steering").length,
      recoveryCount: jobs.filter((job) => job.status === "recovery_required").length,
      activeRunId: bindings.find((binding) => binding.status === "active")?.runId,
      fallback: effective !== requested ? "delivery_unverified" : undefined,
      capabilities,
    }
  }, [adapterId, conversationKey])

  if (!diagnostic) return null
  const capabilityCount = [
    diagnostic.capabilities.textStreaming,
    diagnostic.capabilities.componentMutation,
    diagnostic.capabilities.messageEditing,
    diagnostic.capabilities.interactiveControls,
  ].filter(Boolean).length

  return (
    <InboxChip
      icon={<GitBranchIcon className="size-3" />}
      data-testid="topic-runtime-chip"
      aria-label={t("aria", {
        policy: diagnostic.effective,
        dispatch: diagnostic.dispatch,
      })}
      tooltip={
        <div className="max-w-sm space-y-1">
          <p>{t("requested", { value: diagnostic.requested })}</p>
          <p>{t("effective", { value: diagnostic.effective })}</p>
          <p>{t("readiness", { value: diagnostic.readiness })}</p>
          <p>{t("activation", { value: diagnostic.active ? t("active") : t("inactive") })}</p>
          <p>{t("queue", { count: diagnostic.queueDepth })}</p>
          <p>{t("activeRun", { value: diagnostic.activeRunId ?? t("none") })}</p>
          <p>{t("recovery", { count: diagnostic.recoveryCount })}</p>
          <p>
            {t("capabilities", {
              topic: diagnostic.capabilities.topicIsolation,
              count: capabilityCount,
            })}
          </p>
          {diagnostic.fallback && <p>{t("fallback.delivery_unverified")}</p>}
        </div>
      }
    >
      {t("badge", { policy: diagnostic.effective, dispatch: diagnostic.dispatch })}
    </InboxChip>
  )
}

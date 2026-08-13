"use client"

import { useEffect, useMemo } from "react"
import { liveQuery } from "dexie"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { createOutboundRunner, type OutboundDispatcher } from "@/lib/queue/outbound-queue"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { transport } from "@/lib/tauri"
import {
  setActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { registerRuntimeTargetTransitionParticipant } from "@/lib/runtime/runtime-target-lifecycle"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

const POST_TRIGGER_RUN_SYNC_DELAY_MS = 2500

const liveDispatcher: OutboundDispatcher = {
  async call(command, payload, options) {
    const result = await transport.call(command, payload, options)
    if (command === "workflow_trigger_manual") {
      setTimeout(() => {
        void runSyncDown({ only: ["workflowRuns"] }).catch(() => {})
      }, POST_TRIGGER_RUN_SYNC_DELAY_MS)
    }
    return result
  },
}

function subscribeToPendingJobs(scope: RuntimeTargetScope, onPending: () => void): () => void {
  const subscription = liveQuery(() =>
    getDb()
      .mobileOutboundQueue.where("status")
      .equals("pending")
      .filter((row) => row.accountId === scope.accountId && row.targetId === scope.targetId)
      .count()
  ).subscribe({
    next(count) {
      if (count > 0) onPending()
    },
    error(error) {
      console.warn("companion-outbound-runner: pending-job subscription failed", error)
    },
  })
  return () => subscription.unsubscribe()
}

export interface CompanionOutboundRunnerProviderProps {
  dispatcher?: OutboundDispatcher
  platformOverride?: ReturnType<typeof usePlatform>
  webCompanionOverride?: boolean
  mobilePairedOverride?: boolean
  scopeOverride?: RuntimeTargetScope
}

/**
 * Shared outbound lifecycle for native mobile and paired browser companions.
 * Standalone Web and Tauri never allocate a runner.
 */
export function CompanionOutboundRunnerProvider({
  dispatcher = liveDispatcher,
  platformOverride,
  webCompanionOverride,
  mobilePairedOverride,
  scopeOverride,
}: CompanionOutboundRunnerProviderProps): null {
  const detectedPlatform = usePlatform()
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const runtimeTarget = useRuntimeSnapshot().target
  const mobileRuntimeMode = useSettingsStore((state) => state.settings?.mobileRuntimeMode)
  const platform = platformOverride ?? detectedPlatform
  const hasWebTarget = webCompanionOverride ?? hasWebCompanionTarget()
  const mobilePaired = mobilePairedOverride ?? mobileRuntimeMode === "paired"
  const enabled = (platform === "mobile" && mobilePaired) || (platform === "web" && hasWebTarget)
  const accountId = platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : unlockedAccountId
  const targetId = runtimeTarget?.id ?? null
  const scope = useMemo(
    () => scopeOverride ?? (accountId && targetId ? { accountId, targetId } : null),
    [accountId, scopeOverride, targetId]
  )

  useEffect(() => {
    if (!enabled || !scope) return

    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    const runner = createOutboundRunner({
      dispatcher,
      enforceMobile: false,
      scope,
    })
    const kick = () => {
      void runner.kick().catch((error) => {
        console.warn("companion-outbound-runner: kick failed", error)
      })
    }
    const unsubscribePendingJobs = subscribeToPendingJobs(scope, kick)
    const unregisterTransitionParticipant = registerRuntimeTargetTransitionParticipant({
      id: "companion-outbound-runner",
      phase: "finalize-captures",
      priority: 0,
      run: () => runner.quiesce(),
    })
    kick()

    return () => {
      unsubscribePendingJobs()
      unregisterTransitionParticipant()
      void runner.stop()
    }
  }, [dispatcher, enabled, scope])

  return null
}

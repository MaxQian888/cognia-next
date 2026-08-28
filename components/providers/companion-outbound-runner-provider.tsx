"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import Dexie from "dexie"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { createOutboundRunner, type OutboundDispatcher } from "@/lib/queue/outbound-queue"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { transport } from "@/lib/tauri"
import {
  getActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { registerRuntimeTargetTransitionParticipant } from "@/lib/runtime/runtime-target-lifecycle"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { parseHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { installHostStateSyncForTarget } from "@/lib/sync/host-state-service"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { loadCollabConnection, subscribeCollabConnection } from "@/lib/collab/connection"
import {
  getRuntimeSnapshot,
  runtimeHostSnapshotFromManifest,
  subscribeRuntimeSnapshot,
  updateRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"

const POST_TRIGGER_RUN_SYNC_DELAY_MS = 2500

const liveDispatcher: OutboundDispatcher = {
  async call(command, payload, options) {
    if (command.startsWith("collab_")) {
      const { dispatchCollabOutbound } = await import("@/lib/collab/outbound-dispatcher")
      return dispatchCollabOutbound(command as never, payload)
    }
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
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const subscription = Dexie.liveQuery(() =>
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
 * Shared outbound lifecycle for every attached surface. Standalone Web remains
 * local-only; Tauri deliberately uses the same durable queue as companions so
 * local UI writes exercise identical HostState semantics.
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
  const enabled =
    platform === "tauri" ||
    (platform === "mobile" && mobilePaired) ||
    (platform === "web" && hasWebTarget)
  const accountId = platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : unlockedAccountId
  const collabBaseUrl = useSyncExternalStore(
    subscribeCollabConnection,
    () => (accountId ? (loadCollabConnection(accountId)?.baseUrl ?? "") : ""),
    () => ""
  )
  const collabScope = useMemo<RuntimeTargetScope | null>(
    () =>
      accountId && collabBaseUrl
        ? { accountId, targetId: "collab-plane", routingGeneration: 0 }
        : null,
    [accountId, collabBaseUrl]
  )
  const targetId = runtimeTarget?.id ?? (platform === "tauri" ? "local-host" : null)
  const scope = useMemo(() => {
    if (scopeOverride) return scopeOverride
    if (!accountId || !targetId) return null
    const activeScope = getActiveRuntimeTargetContext()
    return {
      accountId,
      targetId,
      routingGeneration:
        activeScope?.accountId === accountId && activeScope.targetId === targetId
          ? activeScope.routingGeneration
          : 0,
    }
  }, [accountId, scopeOverride, targetId])

  useEffect(() => {
    if (!enabled || !scope) return

    setActiveRuntimeTargetContext(scope.accountId, scope.targetId, scope.routingGeneration)
    const runner = createOutboundRunner({
      dispatcher,
      enforceMobile: false,
      scope,
      canDispatch: (row) =>
        row.protocol !== "host-state" ||
        getRuntimeSnapshot().host?.operations.includes("host_state_submit") === true,
    })
    const kick = () => {
      void runner.kick().catch((error) => {
        console.warn("companion-outbound-runner: kick failed", error)
      })
    }
    const unsubscribePendingJobs = subscribeToPendingJobs(scope, kick)
    const unsubscribeRuntime = subscribeRuntimeSnapshot(kick)
    const unregisterTransitionParticipant = registerRuntimeTargetTransitionParticipant({
      id: "companion-outbound-runner",
      phase: "finalize-captures",
      priority: 0,
      run: () => runner.quiesce(),
    })
    kick()

    return () => {
      unsubscribePendingJobs()
      unsubscribeRuntime()
      unregisterTransitionParticipant()
      void runner.stop()
    }
  }, [dispatcher, enabled, scope])

  useEffect(() => {
    if (!collabScope) return
    const runner = createOutboundRunner({
      dispatcher,
      enforceMobile: false,
      scope: collabScope,
    })
    const kick = () => {
      void runner.kick().catch((error) => {
        console.warn("collab-outbound-runner: kick failed", error)
      })
    }
    const unsubscribe = subscribeToPendingJobs(collabScope, kick)
    kick()
    return () => {
      unsubscribe()
      void runner.stop()
    }
  }, [collabScope, dispatcher])

  useEffect(() => {
    if (platform !== "tauri" || !scope) return
    let cancelled = false
    let stopSync = () => {}
    let unregisterResync = () => {}

    void (async () => {
      const manifest = parseHostFeatureManifest(await transport.call("host_feature_manifest", {}))
      if (cancelled || !manifest) return
      updateRuntimeSnapshot({
        host: runtimeHostSnapshotFromManifest(manifest, { hostStateWriteEnabled: false }),
      })
      if (manifest.features["session.state-sync"]?.version !== 1) return
      const installed = await installHostStateSyncForTarget({
        transport,
        accountId: scope.accountId,
        runtimeTargetId: scope.targetId,
      })
      if (cancelled) {
        installed.stop()
        return
      }
      stopSync = () => installed.stop()
      updateRuntimeSnapshot({ host: runtimeHostSnapshotFromManifest(manifest) })
      unregisterResync = remoteEventResyncCoordinator.register("host-state", () =>
        installed.resync()
      )
    })().catch((error) => {
      console.warn("desktop-host-state: initialization failed; retaining legacy writes", error)
    })

    return () => {
      cancelled = true
      unregisterResync()
      stopSync()
    }
  }, [platform, scope])

  return null
}

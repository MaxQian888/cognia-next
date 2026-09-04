"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import Dexie from "dexie"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { isPlaceholderRuntimeTargetId } from "@/lib/runtime/runtime-target"
import { createOutboundRunner, type OutboundDispatcher } from "@/lib/queue/outbound-queue"
import {
  clearOutboundApproval,
  ensureOutboundApproval,
  hasOutboundApprovalReporter,
  outboundConsentCode,
  PENDING_NO_CODE,
  subscribeOutboundApproval,
  withOutboundApproval,
} from "@/lib/queue/outbound-approval"
import { subscribeToHostConsent } from "@/lib/host-consent/client"
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
    // Interactive commands need a device-bound lease. It is TAKEN by the
    // runner's pre-flight gate below, not here: minting inside the dispatch put
    // a host-admin request behind every background drain, and turned a host
    // waiting on a human into an ordinary delivery failure that retried the
    // row into the deadletter lane. All this does is attach what the gate
    // already holds.
    const approved = withOutboundApproval(command, payload)
    const result = await transport.call(command, approved, options)
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
  // Same strings the mobile banner shows. One wait, one wording, wherever the
  // user happens to be standing.
  const tApproval = useTranslations("mobile.offline")
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
  // The snapshot's target id names a *surface*; this provider installs it as
  // the routing context, which is what `companionStorage().load()` resolves a
  // credential by. `web-companion` is a placeholder the Web boot provider
  // publishes before it knows which Host it talks to, and nothing is ever
  // filed under it — installing it made a freshly paired client fail to find
  // its own record ("no paired-Host record exists for the active runtime
  // target"), because the boot provider re-publishes that opening snapshot on
  // every `restartWebHostBindings()` and so clobbered the real id the pairing
  // had just set. Wait for the real one instead.
  const resolvedTargetId = isPlaceholderRuntimeTargetId(runtimeTarget?.id)
    ? null
    : (runtimeTarget?.id ?? null)
  const targetId = resolvedTargetId ?? (platform === "tauri" ? "local-host" : null)
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

    // Drop the previous target's approval state before the new routing context
    // is installed. The gate keys its cache by this same scope, so this is not
    // what makes a foreign lease unusable — it is what stops a "waiting for
    // approval" banner minted against the old Host from outliving it on screen.
    clearOutboundApproval()
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId, scope.routingGeneration)
    const runner = createOutboundRunner({
      dispatcher,
      enforceMobile: false,
      scope,
      canDispatch: async (row) => {
        if (
          row.protocol === "host-state" &&
          getRuntimeSnapshot().host?.operations.includes("host_state_submit") !== true
        ) {
          return false
        }
        // "blocked" is the host asking for a human, or having just refused.
        // Freezing the row keeps it pending at its place in the channel with
        // its attempt count untouched, which is what makes the answer
        // recoverable rather than a message that quietly ran out of retries.
        return (await ensureOutboundApproval(row.command)) !== "blocked"
      },
    })
    const kick = () => {
      void runner.kick().catch((error) => {
        console.warn("companion-outbound-runner: kick failed", error)
      })
    }
    const unsubscribePendingJobs = subscribeToPendingJobs(scope, kick)
    const unsubscribeRuntime = subscribeRuntimeSnapshot(kick)
    // The approval is answered on someone else's screen. Without this the
    // frozen rows would sit until the refusal cooldown lapsed and something
    // else happened to kick the runner, so a message the user watched being
    // approved still would not move.
    const unsubscribeConsent = subscribeToHostConsent((request) => {
      if (request.state !== "approved") return
      clearOutboundApproval()
      kick()
    })
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
      unsubscribeConsent()
      unregisterTransitionParticipant()
      // Sign-out, unpair, and every target switch land here. Nothing cached
      // survives the target it was taken against.
      clearOutboundApproval()
      void runner.stop()
    }
  }, [dispatcher, enabled, scope])

  // The wait, on whichever shell is running the queue.
  //
  // `ensureOutboundApproval` freezes a row for ANY `companion` target, and a
  // paired desktop browser is one. Only the mobile shells mount
  // `OfflineBanner`, so everywhere else the composer cleared, no turn started
  // and nothing said why, which is the same silence the gate was built to end,
  // one shell over. This provider is mounted exactly where the freeze can
  // happen, which makes it the right place to report it. The banner claims the
  // wait while it is on screen so the two never say it twice.
  useEffect(() => {
    if (!enabled) return
    const TOAST_ID = "outbound-approval-pending"
    let shown = false
    const report = () => {
      const code = outboundConsentCode()
      if (code === null || hasOutboundApprovalReporter()) {
        if (shown) {
          shown = false
          toast.dismiss(TOAST_ID)
        }
        return
      }
      shown = true
      toast.loading(
        code === PENDING_NO_CODE
          ? tApproval("queueAwaitingApprovalNoCode")
          : tApproval("queueAwaitingApproval", { code }),
        { id: TOAST_ID, duration: Infinity }
      )
    }
    const unsubscribe = subscribeOutboundApproval(report)
    report()
    return () => {
      unsubscribe()
      toast.dismiss(TOAST_ID)
    }
  }, [enabled, tApproval])

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

// Notification V2 delivery worker — the runtime loop installed into the
// connector runtime's host-owned lifecycle.
//
// This is the background engine that makes the durable-delivery guarantee
// real: it reconciles projection work, drains webhook intents, projects
// receipts, and fires due timers — on a periodic sweep AND on the wake
// signal the projection-commit touches. It is a HOST-side worker: it claims
// projection work under the runtime's lease identity, so it only ever runs
// on the host that owns the connector runtime (the same `ownsRuntime` gate
// the outbound runner and presentation runner already share).
//
// The worker holds no send logic of its own — it composes the reconciler
// (crash recovery) and the webhook sender (one-way targets) against the
// scope's policy context. Wake is a hint; the periodic reconcile is the
// reliability mechanism.

import { resolvePreferences } from "../preferences"
import { notificationPolicyContext } from "../policy/context"
import { reconcileNotifications } from "./reconciler"
import type { EmitCenterRecord } from "./coordinator"
import { sendPendingWebhookIntents } from "./webhook-sender"
import { splitSecretRef } from "./feishu-webhook"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import type { TauriHttpRequest, TauriHttpResponse } from "@/types/connectors/adapter"

/** How often the reconcile sweep runs — the design's 30s floor. */
export const NOTIFICATION_WORKER_SWEEP_MS = 30_000

export interface NotificationWorkerDeps {
  /** The scope key this host projects for (one namespace+account). */
  scopeKey: string
  /** The lease-owner identity this worker claims work under. */
  leaseOwner: string
  /** Load the resolved notification preferences (settings store). */
  loadPrefs: () =>
    ReturnType<typeof resolvePreferences> | Promise<ReturnType<typeof resolvePreferences>>
  /** POST a governed outbound HTTP request (webhook executor). */
  sendHttp?: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
  /** Resolve a `{service}:{account}` secret ref. */
  resolveSecret?: (ref: string) => Promise<string | null>
  /**
   * In-app center emitter — defaults to the real `notify()`-backed bridge,
   * lazily imported so the worker keeps no static sonner/Tauri edge (and so
   * tests can inject a fake without loading the notification runtime).
   */
  emitCenter?: EmitCenterRecord
  /** Sweep interval — injectable for tests. */
  sweepMs?: number
  /** Log sink. */
  log?: (level: "info" | "warn" | "error", message: string) => void
}

const defaultLog = (level: "info" | "warn" | "error", message: string): void => {
  if (level === "info") console.info(message)
  else if (level === "warn") console.warn(message)
  else console.error(message)
}

/**
 * Resolve a `{service}:{account}` secret ref through the connector keyring.
 * The keyring command takes (adapterId, credential); the service is the
 * adapterId slot, the account the credential name.
 */
async function resolveKeyringSecret(ref: string): Promise<string | null> {
  const split = splitSecretRef(ref)
  if (!split) return null
  return connectorsKeyringGet(split.service, split.account)
}

/**
 * Start the notification delivery worker. Returns a stop function the
 * connector runtime's teardown calls — disposal is idempotent and the
 * worker never runs two sweeps concurrently.
 */
export function startNotificationDeliveryWorker(deps: NotificationWorkerDeps): () => void {
  const log = deps.log ?? defaultLog
  const sweepMs = deps.sweepMs ?? NOTIFICATION_WORKER_SWEEP_MS
  const sendHttp = deps.sendHttp ?? connectorsHttpRequest
  const resolveSecret = deps.resolveSecret ?? resolveKeyringSecret
  let stopped = false
  let running = false
  let emitCenterCache: EmitCenterRecord | undefined = deps.emitCenter
  let timer: ReturnType<typeof setTimeout> | null = null

  const resolveEmitCenter = async (): Promise<EmitCenterRecord> => {
    if (!emitCenterCache) {
      const mod = await import("../emit-center")
      emitCenterCache = mod.emitCenterFromDerivedFact
    }
    return emitCenterCache
  }

  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const prefs = await deps.loadPrefs()
      const policy = notificationPolicyContext(prefs)
      const emitCenter = await resolveEmitCenter().catch(() => undefined)
      const [reconcile, webhook] = await Promise.all([
        reconcileNotifications({
          scopeKey: deps.scopeKey,
          policy,
          leaseOwner: deps.leaseOwner,
          ...(emitCenter ? { emitCenter } : {}),
        }).catch((err) => {
          log("warn", `[notification-worker] reconcile failed: ${String(err)}`)
          return null
        }),
        sendPendingWebhookIntents({
          deps: { sendHttp, resolveSecret },
        }).catch((err) => {
          log("warn", `[notification-worker] webhook send failed: ${String(err)}`)
          return null
        }),
      ])
      if (reconcile && reconcile.errors > 0) {
        log("warn", `[notification-worker] reconcile completed with ${reconcile.errors} error(s)`)
      }
      if (webhook && webhook.failed > 0) {
        log("warn", `[notification-worker] ${webhook.failed} webhook intent(s) failed`)
      }
    } catch (err) {
      log("warn", `[notification-worker] tick failed: ${String(err)}`)
    } finally {
      running = false
    }
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick().finally(schedule)
    }, sweepMs)
  }

  // Kick an immediate pass — work that landed while the app was down is
  // recovered on the first sweep, not after a full interval.
  void tick().finally(schedule)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

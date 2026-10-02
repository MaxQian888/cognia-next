/**
 * Operator self-alerting (plan §13): the external runner reports its own
 * ingestion/status-API/spool trouble through one fixed, operator-configured
 * webhook, because a status service cannot be its own sole alert path.
 * Each alert key fires at most once per cooldown so a long outage produces
 * one page, not one per minute.
 */

import type { FetchLike } from "./http"
import type { Logger } from "./logger"

export const ALERT_COOLDOWN_MS = 30 * 60_000
const ALERT_TIMEOUT_MS = 5_000

export type AlertKey =
  | "ingestion_failing"
  | "ingestion_rejected"
  | "status_api_failing"
  | "spool_overflow"
  | "observer_loss"

export interface AlertSinkOptions {
  webhook: string | null
  probeId: string | null
  logger: Logger
  fetchImpl?: FetchLike
  now?: () => number
  cooldownMs?: number
}

export class AlertSink {
  private readonly lastSent = new Map<string, number>()
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly cooldownMs: number

  constructor(private readonly options: AlertSinkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.cooldownMs = options.cooldownMs ?? ALERT_COOLDOWN_MS
  }

  /**
   * Raise `key`. Returns whether it was delivered (or logged, with no webhook)
   * rather than suppressed by the cooldown. Never throws.
   */
  async raise(
    key: AlertKey,
    summary: string,
    detail: Record<string, string | number> = {}
  ): Promise<boolean> {
    const at = this.now()
    const last = this.lastSent.get(key)
    if (last !== undefined && at - last < this.cooldownMs) return false
    this.lastSent.set(key, at)
    this.options.logger.error("alert", { key, summary, ...detail })
    if (!this.options.webhook) return true
    try {
      const response = await this.fetchImpl(this.options.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "cognia-status-probe",
          probeId: this.options.probeId,
          key,
          summary,
          detail,
          at: new Date(at).toISOString(),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      })
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) {
        this.options.logger.warn("alert_delivery_failed", { key, status: response.status })
        // Let the next occurrence retry instead of waiting out the cooldown.
        this.lastSent.delete(key)
        return false
      }
      return true
    } catch {
      this.options.logger.warn("alert_delivery_failed", { key, status: null })
      this.lastSent.delete(key)
      return false
    }
  }
}

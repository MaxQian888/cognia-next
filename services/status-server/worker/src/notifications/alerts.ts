/**
 * Operator alerts through one fixed, configured channel.
 *
 * The destination is `OPERATOR_ALERT_WEBHOOK` (a Worker secret); no request
 * can supply or change it. Alerts are de-duplicated by key in D1, so a
 * condition that persists for hours produces one alert per cooldown, not
 * one per minute. Without a webhook the alert is only logged. The payload
 * carries non-secret identifiers only.
 */

import { HOUR_MS } from "../../../../../lib/status/contract"
import type { Env } from "../env"
import { logEvent } from "../platform/http"

export const DEFAULT_ALERT_COOLDOWN_MS = HOUR_MS
export const ALERT_TIMEOUT_MS = 10_000

export interface OperatorAlert {
  key: string
  severity: "warning" | "critical"
  summary: string
  nowMs: number
  cooldownMs?: number
}

function webhookUrl(env: Env): string | null {
  const raw = env.OPERATOR_ALERT_WEBHOOK?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Claim the alert slot for `key`: true when no alert with this key was sent
 * within the cooldown (and records this one), false when it is a repeat.
 */
async function claimAlert(db: D1Database, alert: OperatorAlert): Promise<boolean> {
  const cooldown = alert.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS
  const row = await db
    .prepare(
      `INSERT INTO operator_alerts (key, severity, last_sent_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET severity = excluded.severity, last_sent_at = excluded.last_sent_at
       WHERE operator_alerts.last_sent_at <= ?
       RETURNING key`
    )
    .bind(alert.key, alert.severity, alert.nowMs, alert.nowMs - cooldown)
    .first<{ key: string }>()
  return row !== null
}

export async function alertOperator(env: Env, alert: OperatorAlert): Promise<void> {
  if (!(await claimAlert(env.DB, alert))) return
  const url = webhookUrl(env)
  logEvent("operator.alert", {
    key: alert.key,
    severity: alert.severity,
    channel: url ? "webhook" : "log",
  })
  if (!url) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "cognia-status",
        environment: env.STATUS_ENV,
        key: alert.key,
        severity: alert.severity,
        summary: alert.summary,
        at: new Date(alert.nowMs).toISOString(),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      logEvent("operator.alert_failed", { key: alert.key, status: response.status })
    }
  } catch (error) {
    // The alert is recorded as sent for this cooldown anyway: retrying a
    // broken webhook every minute would only add noise to the logs.
    logEvent("operator.alert_failed", {
      key: alert.key,
      status: null,
      error: error instanceof Error ? error.name : "unknown",
    })
  } finally {
    clearTimeout(timer)
  }
}

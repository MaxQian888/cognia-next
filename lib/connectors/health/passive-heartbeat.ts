/**
 * Passive-transport heartbeat probe.
 *
 * The "active" heartbeat in `heartbeat.ts` writes `adapter.heartbeat`
 * rows every 30s carrying `adapter.health()` snapshots. That works fine
 * for adapters whose transport drives an explicit health signal
 * (Telegram long-poll loop, Discord Gateway socket, Slack Socket Mode)
 * — when the transport detaches, `health()` flips to "degraded".
 *
 * **Passive** transports (Lark webhook, OneBot reverse-WS) don't have
 * that property. They sit idle waiting for the platform / client to
 * push events. From the adapter's point of view, "no events for an
 * hour" and "we're working fine, traffic is quiet" look identical.
 *
 * This probe runs every 60s and writes a derived `adapter.heartbeat`
 * row with the following rules:
 *
 *   - If the last `inbound.received` was within 5 min: state = "running",
 *     reason omitted.
 *   - If >5 min and we're inside a configured quiet window: state =
 *     "running", reason = "quiet_hours_silent".
 *   - Otherwise we attempt a lightweight liveness ping (Lark
 *     `/bot/v3/info`, OneBot `connectors_health` running count). On
 *     ping success: state = "running", reason = "idle". On ping
 *     failure: state = "degraded", reason carries the failure detail.
 *
 * The probe never throws — Dexie, network, and audit-writer failures
 * are swallowed so the timer keeps running.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AdapterHealthState } from "@/types/connectors/adapter"
import { getDb } from "@/lib/db/schema"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import {
  connectorsHttpRequest,
  connectorsHealth,
  connectorsKeyringGet,
} from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/connectors/adapters/lark/auth"
import { getRunningAdapter } from "@/lib/connectors/lifecycle"

export const PASSIVE_HEARTBEAT_INTERVAL_MS = 60_000
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000

export interface PassiveProbeOverrides {
  lastInboundAt?: (adapterId: string) => Promise<number | null>
  larkPing?: (row: AdapterInstanceRow) => Promise<boolean>
  onebotPing?: () => Promise<boolean>
  gatewayPing?: (row: AdapterInstanceRow) => Promise<boolean>
  /** Override `isInQuietHours` to make tests deterministic. */
  isInQuietHours?: (nowMs: number, from: string, to: string, tz: string) => boolean
}

/**
 * Returns true for adapter types whose transport waits passively for
 * upstream pushes and therefore benefits from this probe.
 */
export function isPassiveTransport(row: AdapterInstanceRow): boolean {
  if (row.type === "onebot") return true
  if (row.type === "lark") {
    const settings = (row.settings ?? {}) as { transport?: string }
    return settings.transport === "webhook"
  }
  return false
}

/** Gateway/socket transports need the same periodic health probe and redial. */
export function isGatewayTransport(row: AdapterInstanceRow): boolean {
  if (row.type === "dingtalk") return true
  if (!["discord", "slack", "qq-official"].includes(row.type)) return false
  if (row.type === "slack") {
    return (
      row.transportMode === "gateway" ||
      (row.settings as { transport?: string }).transport === "socket-mode"
    )
  }
  return (
    row.transportMode === "gateway" ||
    (row.settings as { transportMode?: string }).transportMode === "gateway"
  )
}

/** Every adapter type whose idle health needs an explicit periodic probe. */
export function benefitsFromProbe(row: AdapterInstanceRow): boolean {
  return isPassiveTransport(row) || isGatewayTransport(row)
}

async function fetchLastInboundAt(adapterId: string): Promise<number | null> {
  try {
    // `[adapterId+kind+at]` (v51) makes this a pure index lookup: the range is
    // exactly this adapter's `inbound.received` rows ordered by `at`, so
    // `.last()` is the newest without a table scan + JS `kind` filter.
    const newest = await getDb()
      .connectorAudit.where("[adapterId+kind+at]")
      .between(
        [adapterId, "inbound.received", -Infinity],
        [adapterId, "inbound.received", Infinity]
      )
      .last()
    return newest?.at ?? null
  } catch {
    return null
  }
}

async function pingLark(row: AdapterInstanceRow): Promise<boolean> {
  try {
    const appId = (await connectorsKeyringGet(row.id, "appId")) ?? ""
    const appSecret = (await connectorsKeyringGet(row.id, "appSecret")) ?? ""
    if (!appId || !appSecret) return false
    const tat = await getTenantAccessToken({ appId, appSecret })
    if (!tat) return false
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: `Bearer ${tat}` },
      timeoutMs: 5_000,
    })
    if (resp.status >= 200 && resp.status < 300) return true
    return false
  } catch {
    return false
  }
}

async function pingOneBot(): Promise<boolean> {
  // OneBot uses reverse-WS — the QQ client connects to our axum server.
  // Without a dedicated `connectors_onebot_probe` Tauri command (out of
  // scope per the plan), we settle for the global server-health signal:
  // the axum server must be running and at least one adapter registered.
  // A more authoritative client-count probe is a follow-up.
  try {
    const health = await connectorsHealth()
    return health.serverRunning && health.registeredAdapterCount > 0
  } catch {
    return false
  }
}

async function pingGateway(row: AdapterInstanceRow): Promise<boolean> {
  try {
    const entry = getRunningAdapter(row.id)
    return entry?.adapter.health?.().state === "running"
  } catch {
    return false
  }
}

export interface DerivedHeartbeat {
  state: AdapterHealthState
  reason?: string
  lastInboundAt: number | null
  pingOk: boolean | null
}

/**
 * Compute the heartbeat state for a passive adapter at a given moment.
 * Exported so tests can drive it directly without spinning a timer.
 */
export async function deriveHeartbeat(
  row: AdapterInstanceRow,
  options: { now?: number; idleThresholdMs?: number; probeOverrides?: PassiveProbeOverrides } = {}
): Promise<DerivedHeartbeat> {
  const now = options.now ?? Date.now()
  const idleThreshold = options.idleThresholdMs ?? IDLE_THRESHOLD_MS

  const lastInboundAt = await (options.probeOverrides?.lastInboundAt
    ? options.probeOverrides.lastInboundAt(row.id)
    : fetchLastInboundAt(row.id))

  const ageMs = lastInboundAt == null ? Number.POSITIVE_INFINITY : now - lastInboundAt
  if (ageMs <= idleThreshold) {
    return { state: "running", lastInboundAt, pingOk: null }
  }

  // Quiet hours silence is expected; mark as running but annotate so the
  // Health view can hint at the cause.
  const quietCheck = options.probeOverrides?.isInQuietHours ?? isInQuietHours
  if (
    row.quietHours &&
    quietCheck(now, row.quietHours.from, row.quietHours.to, row.quietHours.tz)
  ) {
    return {
      state: "running",
      reason: "quiet_hours_silent",
      lastInboundAt,
      pingOk: null,
    }
  }

  let pingOk = false
  if (row.type === "lark") {
    pingOk = await (options.probeOverrides?.larkPing
      ? options.probeOverrides.larkPing(row)
      : pingLark(row))
  } else if (row.type === "onebot") {
    pingOk = await (options.probeOverrides?.onebotPing
      ? options.probeOverrides.onebotPing()
      : pingOneBot())
  } else if (isGatewayTransport(row)) {
    pingOk = await (options.probeOverrides?.gatewayPing
      ? options.probeOverrides.gatewayPing(row)
      : pingGateway(row))
  }

  if (pingOk) {
    return { state: "running", reason: "idle", lastInboundAt, pingOk: true }
  }
  return {
    state: "degraded",
    reason:
      row.type === "lark"
        ? "lark_ping_failed"
        : row.type === "onebot"
          ? "onebot_no_client"
          : isGatewayTransport(row)
            ? "gateway_probe_failed"
            : "ping_failed",
    lastInboundAt,
    pingOk: false,
  }
}

export async function recordPassiveProbe(
  row: AdapterInstanceRow,
  now: number,
  idleThresholdMs: number,
  probeOverrides?: PassiveProbeOverrides
): Promise<DerivedHeartbeat> {
  const derived = await deriveHeartbeat(row, { now, idleThresholdMs, probeOverrides })
  await getDb()
    .connectorHeartbeats.put({
      id: crypto.randomUUID(),
      adapterId: row.id,
      kind: "adapter.heartbeat",
      at: now,
      reason: derived.reason,
      fields: {
        state: derived.state,
        reason: derived.reason,
        source: "passive_probe",
        lastInboundAt: derived.lastInboundAt,
        pingOk: derived.pingOk,
        idleThresholdMs,
      },
    })
    .catch(() => undefined)
  return derived
}

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
import { appendAudit } from "@/lib/connectors/audit"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import {
  connectorsHttpRequest,
  connectorsHealth,
  connectorsKeyringGet,
} from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/connectors/adapters/lark/auth"

export const PASSIVE_HEARTBEAT_INTERVAL_MS = 60_000
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000

export interface PassiveHeartbeatHandle {
  dispose(): void
}

export interface StartPassiveHeartbeatOptions {
  row: AdapterInstanceRow
  /** Override the interval (tests use a small value). */
  intervalMs?: number
  /** Override the idle threshold (tests). */
  idleThresholdMs?: number
  /** Override the clock (tests). */
  now?: () => number
  /** Override the scheduler (tests). */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** Pre-resolved probe overrides (tests). */
  probeOverrides?: PassiveProbeOverrides
}

export interface PassiveProbeOverrides {
  lastInboundAt?: (adapterId: string) => Promise<number | null>
  larkPing?: (row: AdapterInstanceRow) => Promise<boolean>
  onebotPing?: () => Promise<boolean>
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

async function fetchLastInboundAt(adapterId: string): Promise<number | null> {
  try {
    const newest = await getDb()
      .connectorAudit.where("at")
      .above(0)
      .filter((row) => row.adapterId === adapterId && row.kind === "inbound.received")
      .reverse()
      .first()
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

interface DerivedHeartbeat {
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
): Promise<void> {
  const derived = await deriveHeartbeat(row, { now, idleThresholdMs, probeOverrides })
  await appendAudit({
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
  }).catch(() => undefined)
}

/**
 * Start a 60s probe loop for a passive-transport adapter. Returns a
 * disposer the caller must invoke on adapter teardown. The first probe
 * fires immediately so the Health view has data without waiting one
 * full interval.
 *
 * No-op for non-passive transports — the caller is expected to gate on
 * `isPassiveTransport(row)`, but the guard is defensive and the
 * function exits cleanly if a non-passive row sneaks in.
 */
export function startPassiveHeartbeat(
  options: StartPassiveHeartbeatOptions
): PassiveHeartbeatHandle {
  const {
    row,
    intervalMs = PASSIVE_HEARTBEAT_INTERVAL_MS,
    idleThresholdMs = IDLE_THRESHOLD_MS,
    now,
    scheduler = {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    probeOverrides,
  } = options

  if (!isPassiveTransport(row)) {
    return { dispose: () => undefined }
  }

  let disposed = false
  const clock = now ?? Date.now

  const tick = () => {
    if (disposed) return
    void recordPassiveProbe(row, clock(), idleThresholdMs, probeOverrides).catch(() => undefined)
  }

  tick()
  const handle = scheduler.setInterval(tick, intervalMs)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      scheduler.clearInterval(handle)
    },
  }
}

/**
 * Remote-host notification ingest (ADR-0042 + spec
 * `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`, E).
 *
 * A headless cognia-server has no toast, no OS notification and no push
 * fan-out of its own; when its brain calls `notify()` the interruptive
 * channels are collapsed into `remote_notification_publish`, which broadcasts a
 * `notification://remote` frame on the events plane. This module is the
 * receiving half: any client whose transport reaches that host — a paired
 * phone, a cloud-companion browser, or a desktop currently driving the remote
 * host (ADR-0082) — subscribes to the channel and files each frame into its
 * OWN Notification Center through the normal `notify()` pipeline, so local
 * preferences, DND, dedupe and the toast/OS channels all apply as if the
 * event had happened locally.
 *
 * Idempotent per transport: frames are keyed by `remote:<host>:<id>` so a
 * replayed frame after a reconnect coalesces onto the same record.
 */

import type { NotificationLevel, NotificationSource } from "@/types/notifications"
import { notify } from "./runtime"
import { transport as defaultTransport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { detectHostProfile } from "@/lib/platform/capabilities"

export const REMOTE_NOTIFICATION_CHANNEL = "notification://remote"

const KNOWN_SOURCES: ReadonlySet<string> = new Set<NotificationSource>([
  "scheduler",
  "agent-team",
  "plugin",
  "connector",
  "session",
  "workflow",
  "system",
])
const KNOWN_LEVELS: ReadonlySet<string> = new Set<NotificationLevel>([
  "info",
  "success",
  "warning",
  "error",
  "critical",
])

export interface RemoteNotificationFrame {
  id: string
  title: string
  body?: string
  level?: string
  href?: string | null
  source?: string | null
  createdAt?: number
}

/** Runtime validation of an inbound frame; returns null for junk. */
export function parseRemoteNotificationFrame(raw: unknown): RemoteNotificationFrame | null {
  if (!raw || typeof raw !== "object") return null
  const frame = raw as Record<string, unknown>
  if (typeof frame.id !== "string" || frame.id.length === 0) return null
  if (typeof frame.title !== "string" || frame.title.trim().length === 0) return null
  return {
    id: frame.id,
    title: frame.title,
    body: typeof frame.body === "string" ? frame.body : undefined,
    level: typeof frame.level === "string" ? frame.level : undefined,
    href: typeof frame.href === "string" ? frame.href : null,
    source: typeof frame.source === "string" ? frame.source : null,
    createdAt: typeof frame.createdAt === "number" ? frame.createdAt : undefined,
  }
}

export interface RemoteNotificationIngestOptions {
  /** Stable label of the host the frame came from (dedupe scope). */
  hostKey: string
  notifyFn?: typeof notify
}

/** File one remote frame into the local center. Exported for tests. */
export async function ingestRemoteNotification(
  raw: unknown,
  options: RemoteNotificationIngestOptions
): Promise<string | null> {
  const frame = parseRemoteNotificationFrame(raw)
  if (!frame) return null
  const source: NotificationSource = KNOWN_SOURCES.has(frame.source ?? "")
    ? (frame.source as NotificationSource)
    : "system"
  const level: NotificationLevel = KNOWN_LEVELS.has(frame.level ?? "")
    ? (frame.level as NotificationLevel)
    : "info"
  const doNotify = options.notifyFn ?? notify
  return doNotify({
    source,
    level,
    title: frame.title,
    body: frame.body && frame.body !== frame.title ? frame.body : undefined,
    href:
      frame.href && frame.href.startsWith("/") && !frame.href.startsWith("//")
        ? frame.href
        : undefined,
    dedupeKey: `remote:${options.hostKey}:${frame.id}`,
    groupKey: `remote:${options.hostKey}`,
    // Local fan-out only — never re-publish a remote frame back to a host.
    channels: ["center", "toast", "os"],
  })
}

export interface RemoteNotificationSubscriptionDeps {
  /** Transport to subscribe on; defaults to the process-wide one. */
  transport?: Pick<Transport, "subscribe">
  hostKey?: string
  notifyFn?: typeof notify
}

/**
 * Subscribe `transport` to `notification://remote` and ingest every frame.
 * Returns an unsubscribe. Safe on transports without an events plane (the
 * web stub returns a no-op unsubscribe).
 */
export function subscribeRemoteNotifications(
  deps: RemoteNotificationSubscriptionDeps = {}
): () => void {
  const transport = deps.transport ?? defaultTransport
  const hostKey = deps.hostKey ?? "paired-host"
  if (typeof transport.subscribe !== "function") return () => undefined
  try {
    return transport.subscribe<unknown>(REMOTE_NOTIFICATION_CHANNEL, (payload) => {
      void ingestRemoteNotification(payload, { hostKey, notifyFn: deps.notifyFn }).catch(
        () => undefined
      )
    })
  } catch {
    return () => undefined
  }
}

/**
 * Install the remote-notification listener for this client:
 *
 *   - `cloud-companion` / `mobile-companion` — the process transport already
 *     points at the paired host; subscribe once.
 *   - `desktop` — subscribe to whichever remote host is active
 *     (`transport-routing`), re-binding when the user switches or disconnects.
 *   - `web-standalone` / `headless` — nothing to listen to; no-op.
 *
 * Returns a disposer. Idempotent per call site (call once from an initializer).
 */
export function installRemoteNotificationListener(
  deps: { notifyFn?: typeof notify } = {}
): () => void {
  const profile = detectHostProfile()
  if (profile === "cloud-companion" || profile === "mobile-companion") {
    return subscribeRemoteNotifications({ hostKey: profile, notifyFn: deps.notifyFn })
  }
  if (profile !== "desktop") return () => undefined

  let current: (() => void) | null = null
  const bind = (remote: Transport | null) => {
    current?.()
    current = null
    if (!remote) return
    current = subscribeRemoteNotifications({
      transport: remote,
      hostKey: "remote-host",
      notifyFn: deps.notifyFn,
    })
  }
  bind(getActiveRemoteTransport())
  const unsubscribeRouting = subscribeActiveRemoteTransport((next) => bind(next))
  return () => {
    unsubscribeRouting()
    current?.()
    current = null
  }
}

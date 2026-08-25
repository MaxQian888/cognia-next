// The single notification pipe (ADR-0042). Every subsystem funnels here.
// DI-style (mirrors `team-notifier`) so the orchestration is unit-testable
// without Dexie / sonner / Tauri. The host wires real deps once in
// `lib/notifications/runtime.ts`.

import { nanoid } from "nanoid"
import type {
  NotificationInput,
  NotificationRecord,
  NotificationChannel,
  NotificationPreferences,
} from "@/types/notifications"
import { resolveChannels, type RoutingDecision } from "./routing"
import { coalesceSince, decideCoalesce, buildBumpPatch } from "./dedup"

export interface NotifyDbPort {
  findByDedupeKey(dedupeKey: string, sinceMs: number): Promise<NotificationRecord | undefined>
  putNotification(rec: NotificationRecord): Promise<void>
  patchNotification(id: string, patch: Partial<NotificationRecord>): Promise<void>
  pruneNotifications(opts: { now: number; maxAgeMs: number; maxItems: number }): Promise<number>
}

export interface NotifyDeps {
  now: () => number
  loadPrefs: () => NotificationPreferences | Promise<NotificationPreferences>
  db: NotifyDbPort
  /** In-app toast fan-out (sonner). */
  toast?: (rec: NotificationRecord) => void
  /** OS notification fan-out (Tauri). */
  osNotify?: (opts: { title: string; body?: string; href?: string }) => void | Promise<void>
  /** Mobile push fan-out. */
  push?: (rec: NotificationRecord) => void | Promise<void>
  /**
   * IM proactive-push fan-out (control-plane notifications). Routes the record
   * to a bound IM conversation (resolved from `record.sourceRef`), gated on the
   * per-conversation opt-in + PII. Wired in `runtime.ts` to
   * `lib/notifications/im-deliver`.
   */
  imDeliver?: (rec: NotificationRecord) => void | Promise<void>
  /** Gate OS delivery on permission (defaults to allowed). */
  isOsPermitted?: () => boolean | Promise<boolean>
  /** Reactive store hook — called after persist so the badge/panel update. */
  onRecord?: (rec: NotificationRecord, decision: RoutingDecision) => void
  /** IANA tz for DND evaluation (defaults to the host's local zone). */
  tz?: string
  /** Override id generation (tests). */
  newId?: () => string
  /**
   * Which workspace a session belongs to, for stamping the record's source
   * label. Injected rather than imported so `notify` keeps no Dexie
   * dependency; absent (or throwing) simply leaves the label off, which is
   * strictly better than losing the notification.
   */
  resolveSessionWorkspace?: (sessionId: string) => Promise<string | null | undefined>
}

async function runSafely(label: string, fn: () => void | Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    // A failing channel must never break the others or the persist.
    console.warn(`notify: ${label} channel failed`, err)
    return false
  }
}

/**
 * Emit a notification. Persists the durable `center` record (insert or coalesce
 * bump), fans out to the resolved channels, updates the reactive store, and
 * triggers best-effort retention. Returns the record id (existing id on bump).
 */
export async function notify(input: NotificationInput, deps: NotifyDeps): Promise<string> {
  const now = deps.now()
  const prefs = await deps.loadPrefs()
  const decision = resolveChannels(input, prefs, now, deps.tz)

  // 1. Coalesce decision.
  let existing: NotificationRecord | undefined
  if (input.dedupeKey) {
    existing = await deps.db.findByDedupeKey(input.dedupeKey, coalesceSince(now))
  }
  const action = decideCoalesce(existing, { now, backoff: input.coalesceBackoff })

  // 2. Build/merge the record (deliveredVia filled after fan-out).
  let record: NotificationRecord
  if (action === "bump" && existing) {
    const patch = buildBumpPatch(
      existing,
      {
        title: input.title,
        body: input.body,
        level: input.level,
        href: input.href,
        icon: input.icon,
        directed: input.directed,
        meta: input.meta,
      },
      now
    )
    record = { ...existing, ...patch }
  } else {
    // Which workspace this came from. The caller knows best; failing that, a
    // session-scoped notification inherits its conversation's workspace. Never
    // fatal — an unlabelled notification is far better than a lost one.
    //
    // Inside this branch, not above it: a bump keeps `existing.projectId`, so
    // resolving before the split paid a Dexie round-trip per coalesced
    // notification for a value that was then thrown away — and every await
    // between `findByDedupeKey` and the write widens the window in which two
    // concurrent calls both see no existing row and each insert one.
    let projectId = input.projectId
    if (!projectId && input.sourceRef?.kind === "session" && deps.resolveSessionWorkspace) {
      try {
        projectId = (await deps.resolveSessionWorkspace(input.sourceRef.id)) ?? undefined
      } catch {
        projectId = undefined
      }
    }
    const id = (deps.newId ?? nanoid)()
    record = {
      id,
      source: input.source,
      level: input.level,
      title: input.title,
      body: input.body,
      createdAt: now,
      updatedAt: now,
      readState: "unseen",
      dedupeKey: input.dedupeKey,
      groupKey: input.groupKey,
      count: 1,
      href: input.href,
      actions: input.actions,
      sourceRef: input.sourceRef,
      pluginId: input.pluginId,
      projectId,
      icon: input.icon,
      directed: input.directed === true,
      deliveredVia: ["center"],
      expiresAt: input.ttlMs ? now + input.ttlMs : undefined,
      meta: input.meta,
    }
  }

  // 3. Fan out (center is the persist itself).
  const delivered: NotificationChannel[] = ["center"]
  for (const channel of decision.channels) {
    if (channel === "center") continue
    if (channel === "toast" && deps.toast) {
      if (await runSafely("toast", () => deps.toast!(record))) delivered.push("toast")
    } else if (channel === "os" && deps.osNotify) {
      const permitted = deps.isOsPermitted ? await deps.isOsPermitted() : true
      if (permitted) {
        if (
          await runSafely("os", () =>
            deps.osNotify!({ title: record.title, body: record.body, href: record.href })
          )
        ) {
          delivered.push("os")
        }
      }
    } else if (channel === "push" && deps.push) {
      if (await runSafely("push", () => deps.push!(record))) delivered.push("push")
    } else if (channel === "im" && deps.imDeliver) {
      if (await runSafely("im", () => deps.imDeliver!(record))) delivered.push("im")
    }
  }
  record.deliveredVia = delivered

  // 4. Persist.
  if (action === "bump" && existing) {
    await deps.db.patchNotification(record.id, {
      ...buildBumpPatch(
        existing,
        {
          title: input.title,
          body: input.body,
          level: input.level,
          href: input.href,
          icon: input.icon,
          directed: input.directed,
          meta: input.meta,
        },
        now
      ),
      deliveredVia: delivered,
    })
  } else {
    await deps.db.putNotification(record)
  }

  // 5. Reactive store.
  deps.onRecord?.(record, decision)

  // 6. Best-effort retention (never blocks the caller).
  void deps.db
    .pruneNotifications({
      now,
      maxAgeMs: prefs.retentionMaxAgeMs,
      maxItems: prefs.retentionMaxItems,
    })
    .catch(() => {})

  return record.id
}

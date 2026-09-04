/**
 * Watch a host's automation engine, and stop it.
 *
 * Every read here goes through `transport`, so it resolves over Tauri IPC on
 * the desktop and over the companion RPC plane from a paired phone or browser.
 * That second path only started working when `automation_settings_get`,
 * `automation_kill_switch_engaged`, `automation_audit_snapshot` and
 * `automation_kill_switch` were promoted off `transports: ["internal"]`.
 *
 * The audit rows come from the Rust in-memory ring rather than Dexie. The
 * Dexie mirror is written by the desktop renderer's own event listener, so it
 * does not exist on a phone. The ring is the only history a remote supervisor
 * can see, and it is capped host-side.
 *
 * Deliberately absent: anything that drives the machine, and anything that
 * reconfigures the gate. Those keep their desktop-local commands. A supervisor
 * watches and halts.
 */

import { desktop, type AuditDecision, type AuditEntry, type Tier } from "@/lib/automation/client"

/** How many recent rows a supervision view asks for by default. */
export const DEFAULT_RECENT_LIMIT = 25

export interface AutomationActivityCounts {
  total: number
  allow: number
  deny: number
  consent: number
}

export interface AutomationSupervisionSnapshot {
  /** The operator's master switch. False means the gate refuses everything. */
  enabled: boolean
  /** Engaged means a halt is in force and in-flight calls were rejected. */
  killSwitchEngaged: boolean
  defaultTier: Tier
  /** Newest first, capped at the requested limit. */
  recent: AuditEntry[]
  /** Counts over the whole ring the host returned, not just `recent`. */
  counts: AutomationActivityCounts
  /** When this snapshot was taken, so a view can age it without calling Date.now() during render. */
  readAt: number
}

export function countDecisions(entries: readonly AuditEntry[]): AutomationActivityCounts {
  const counts: AutomationActivityCounts = { total: entries.length, allow: 0, deny: 0, consent: 0 }
  for (const entry of entries) {
    const decision: AuditDecision = entry.decision
    if (decision === "allow") counts.allow += 1
    else if (decision === "deny") counts.deny += 1
    else if (decision === "consent") counts.consent += 1
  }
  return counts
}

/**
 * Read the host's automation state in one round trip set.
 *
 * The three reads run together: a supervision view that showed the engine as
 * running while its audit list was still loading would be reporting two
 * different moments as one.
 */
export async function readAutomationSupervision(
  limit = DEFAULT_RECENT_LIMIT
): Promise<AutomationSupervisionSnapshot> {
  const [settings, killSwitchEngaged, entries] = await Promise.all([
    desktop.settingsGet(),
    desktop.killSwitchEngaged(),
    desktop.auditSnapshot(),
  ])
  // The ring arrives oldest-first from the host. A supervisor reads it the
  // other way round, so the newest decision is the one at the top.
  const newestFirst = [...entries].sort((a, b) => b.ts - a.ts)
  return {
    enabled: settings.enabled,
    killSwitchEngaged,
    defaultTier: settings.defaultTier,
    recent: newestFirst.slice(0, limit),
    counts: countDecisions(entries),
    readAt: Date.now(),
  }
}

/**
 * Halt every automation surface on the host.
 *
 * The host clears session consent grants as part of engaging, so a halt is not
 * just a pause. Previously granted "don't ask again" windows are gone and the
 * next call prompts again. Remote callers need the remote-control capability,
 * the same one the consent reply needs, and get a 403 without it.
 */
export async function haltAutomation(): Promise<void> {
  await desktop.killSwitch()
}

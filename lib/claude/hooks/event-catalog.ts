// Single source of truth for the lifecycle hook events the runtime knows about.
//
// Before this module, three lists drifted apart: the `HookEvent` union
// (`lib/claude/hooks.ts`), the settings panel's local `HOOK_EVENTS` /
// `NO_TRIGGER_EVENTS`, and the chat hook-notice row's `KNOWN_EVENTS` (only 13
// of 27). The catalog below is the only place events, their lifecycle category,
// and their dormant status are declared; the settings panel and the chat row
// both derive from it, so the lists can never re-diverge.
//
// Pure data + small helpers, deliberately free of React / lucide / i18n imports
// so it stays trivially unit-testable and never pulls client deps into a lib
// module. i18n labels are looked up by convention by the consumers under the
// `hooks` namespace (`hooks.events.<EventId>.{label,desc}`, `hooks.categories.*`).

import type { HookEvent } from "@/lib/claude/hooks"

/** Lifecycle grouping used to organise the settings panel. */
export type HookEventCategory = "tools" | "session" | "permissions" | "tasks" | "lifecycle"

export interface HookEventMeta {
  event: HookEvent
  category: HookEventCategory
  /**
   * The runtime recognises and round-trips this event but has no trigger source
   * for it yet — hooks configured here never fire. Surfaced (not hidden) so the
   * UI can mark it honestly. Folded in from the old `NO_TRIGGER_EVENTS` set.
   */
  dormant: boolean
}

/**
 * Authoritative per-event metadata. Typed as a full `Record<HookEvent, …>` so
 * adding a 28th member to the `HookEvent` union without an entry here is a
 * COMPILE error — this is what permanently prevents the event lists from
 * drifting apart again.
 */
const EVENT_META: Record<HookEvent, { category: HookEventCategory; dormant?: boolean }> = {
  // tools
  PreToolUse: { category: "tools" },
  PostToolUse: { category: "tools" },
  PostToolBatch: { category: "tools" },
  PostToolUseFailure: { category: "tools" },
  // session
  SessionStart: { category: "session" },
  SessionEnd: { category: "session" },
  UserPromptSubmit: { category: "session" },
  UserPromptExpansion: { category: "session", dormant: true },
  Stop: { category: "session" },
  StopFailure: { category: "session" },
  Notification: { category: "session" },
  // permissions
  PermissionRequest: { category: "permissions" },
  PermissionDenied: { category: "permissions" },
  Elicitation: { category: "permissions", dormant: true },
  ElicitationResult: { category: "permissions", dormant: true },
  // tasks
  TaskCreated: { category: "tasks" },
  TaskCompleted: { category: "tasks" },
  SubagentStop: { category: "tasks" },
  TeammateIdle: { category: "tasks", dormant: true },
  // lifecycle
  PreCompact: { category: "lifecycle" },
  PostCompact: { category: "lifecycle" },
  WorktreeCreate: { category: "lifecycle", dormant: true },
  WorktreeRemove: { category: "lifecycle", dormant: true },
  FileChanged: { category: "lifecycle", dormant: true },
  CwdChanged: { category: "lifecycle" },
  InstructionsLoaded: { category: "lifecycle" },
  ConfigChange: { category: "lifecycle" },
}

/** Stable category order for the settings panel sections. */
export const HOOK_EVENT_CATEGORIES: readonly HookEventCategory[] = [
  "tools",
  "session",
  "permissions",
  "tasks",
  "lifecycle",
]

/** Every event, grouped by category in the order they were declared above. */
export const HOOK_EVENT_CATALOG: readonly HookEventMeta[] = (
  Object.entries(EVENT_META) as [HookEvent, { category: HookEventCategory; dormant?: boolean }][]
).map(([event, m]) => ({ event, category: m.category, dormant: m.dormant ?? false }))

/** Flat event list — replaces the settings panel's local `HOOK_EVENTS`. */
export const HOOK_EVENTS: readonly HookEvent[] = HOOK_EVENT_CATALOG.map((m) => m.event)

/** Lookup table from event id to its metadata. */
export const HOOK_EVENT_META: Record<HookEvent, HookEventMeta> = HOOK_EVENT_CATALOG.reduce(
  (acc, m) => {
    acc[m.event] = m
    return acc
  },
  {} as Record<HookEvent, HookEventMeta>
)

/** Events partitioned by category (each in declaration order). */
export function hookEventsByCategory(): Record<HookEventCategory, HookEventMeta[]> {
  const out = {} as Record<HookEventCategory, HookEventMeta[]>
  for (const cat of HOOK_EVENT_CATEGORIES) out[cat] = []
  for (const m of HOOK_EVENT_CATALOG) out[m.category].push(m)
  return out
}

/** True when the event has no trigger source yet (never fires). */
export function isDormantEvent(event: HookEvent): boolean {
  return HOOK_EVENT_META[event].dormant
}

const HOOK_EVENT_SET: ReadonlySet<string> = new Set<string>(HOOK_EVENTS)

/**
 * True when `event` is a recognised lifecycle event (so a localized label
 * exists). Replaces the chat row's local `KNOWN_EVENTS` set — an unrecognised
 * future id still falls back to its raw value.
 */
export function isKnownHookEvent(event: string): event is HookEvent {
  return HOOK_EVENT_SET.has(event)
}

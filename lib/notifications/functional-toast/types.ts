// Functional-toast spec contract. A functional toast is the "card" tier of
// the toast channel: one shared chrome (`frame.tsx`) plus a per-producer spec
// factory that maps a persisted NotificationRecord to a spec. The registry
// (`registry.ts`) picks the factory; `runtime.ts` falls back to the plain
// sonner toast when no factory matches.

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import type { NotificationAction, NotificationRecord } from "@/types/notifications"
import type { UnifiedTriggerSummary } from "@/types/scheduler/unified"

/** Eyebrow/status tones shared by every functional toast. */
export type FunctionalToastTone = "live" | "ok" | "warn" | "danger" | "muted"

/**
 * One quiet action in the card's footer row. `notificationAction` links it to
 * a persisted `NotificationAction` on the record so the click dispatches
 * through `lib/notifications/action-registry` — the same path the center's
 * action row uses, so toast and center can never disagree about what a button
 * does.
 */
export interface FunctionalToastActionSpec {
  id: string
  label: string
  icon?: LucideIcon
  /** The single emphasized action (e.g. "Open" / "Approve"). At most one. */
  strong?: boolean
  /** Danger styling for destructive actions. */
  tone?: "default" | "danger"
  notificationAction?: NotificationAction
}

/**
 * Everything the shared frame needs to draw one card. All user-facing strings
 * arrive already localized — factories receive a translator through the
 * context, so specs stay plain data and the frame owns zero copy.
 */
export interface FunctionalToastSpec {
  /** Left identity plate (kind plate, avatar, status tile). */
  icon: ReactNode
  /** Status line above the title; `pulse` animates the dot for live states. */
  eyebrow: { text: string; tone: FunctionalToastTone; pulse?: boolean }
  /** Right-hand tray content on the eyebrow line (schedule chip, duration). */
  tray?: ReactNode
  title: string
  /** The kind-specific slot: timeline, progress bar, message excerpt, etc. */
  body?: ReactNode
  footnote?: ReactNode
  /** Quiet footer actions — keep to ≤3. */
  actions?: FunctionalToastActionSpec[]
  /** Tailwind classes for the bottom accent strip (kind/status color). */
  accentClass?: string
}

/**
 * What the host component hands a spec factory at render time. The factory
 * itself is resolved synchronously from the record (no React needed); the
 * spec is only built inside the card where translations and locale are
 * available.
 */
export interface FunctionalToastContext {
  t: (key: string, values?: Record<string, string | number>) => string
  /** BCP-47 locale for Intl formatters the factory builds itself. */
  locale: string
  /** Render clock — injected so specs and tests share one `now`. */
  now: number
  /** Localized one-line trigger summary, the same text the scheduler list shows. */
  triggerText: (trigger: UnifiedTriggerSummary) => string
}

export type FunctionalToastFactory = (
  rec: NotificationRecord,
  ctx: FunctionalToastContext
) => FunctionalToastSpec | null

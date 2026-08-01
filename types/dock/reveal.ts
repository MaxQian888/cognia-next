/**
 * A request to bring a panel to the user's attention.
 *
 * Reveal is the operation that most often fights the user's layout, so its
 * contract is explicit: a reveal *prefers* an existing instance, *may* be
 * downgraded to an unread badge, and never steals focus from a group the user
 * is working in. ADR-0083 established that pinning turns automatic reveals into
 * pending state; the dock keeps that and adds "which group" to the decision.
 */

import type { DockResourceRef, DockTabMode } from "./instance"

/** Who asked. Automatic sources are the ones a pinned layout suppresses. */
export type DockRevealSource =
  /** The user clicked something that means "show me this". Always focuses. */
  | "user"
  /** A diagnostic, a proposal, a finished run. Badge-only when suppressed. */
  | "automatic"
  /** A plugin calling `reveal()`. Same suppression rules as `automatic`. */
  | "plugin"

/** What the requester wants to happen to focus. */
export type DockRevealFocusPolicy =
  /** Activate the tab and move keyboard focus into it. */
  | "focus"
  /** Activate the tab but leave focus where it is. */
  | "activate"
  /** Only mark it unread; never change the active tab. */
  | "notify"

export interface DockRevealRequest {
  panelId: string
  /** Set for `multi-instance` panels — which resource to reveal. */
  resource?: DockResourceRef
  source: DockRevealSource
  focus: DockRevealFocusPolicy
  /**
   * Open as a preview tab when no instance exists yet. Defaults to `pinned`,
   * because a reveal is a deliberate act by definition — only the file tree's
   * browse gesture wants a preview slot.
   */
  mode?: DockTabMode
}

/** What the kernel decided to do with a reveal. */
export type DockRevealOutcome =
  /** An existing instance was activated. */
  | { kind: "activated"; instanceId: string; focused: boolean }
  /** A new instance was opened. */
  | { kind: "opened"; instanceId: string; focused: boolean; evictedInstanceId: string | null }
  /** The layout was left alone; the tab carries an unread badge instead. */
  | { kind: "badged"; instanceId: string }
  /** Nothing to reveal — the panel does not resolve for the current resource. */
  | { kind: "unavailable"; reason: DockRevealUnavailableReason }

export type DockRevealUnavailableReason =
  "panel-not-registered" | "panel-not-applicable" | "permission-denied" | "native-surface-busy"

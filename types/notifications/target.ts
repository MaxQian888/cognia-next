// Notification V2 delivery target contract.
//
// A target is ONE canonical external destination (a bound IM conversation or
// a one-way Feishu webhook) plus the consent that authorizes proactive pushes
// to it. The address — not the row id — is what dedupes two alias rows that
// name the same group chat; `addressFingerprint` is the canonical form the
// delivery-slot key uses.

import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import type { NotificationScope } from "./scope"

/** How a target may lawfully be reached. */
export type NotificationTargetConsentMode = "origin-reply" | "proactive"

/**
 * The external address a target delivers to.
 *
 * - `connector` — a governed IM adapter + conversation. `deliveryTarget` is
 *   the refreshed sendable handle the adapter produced; `conversationKey`
 *   stays only as a compatibility/index handle, never a model-constructible
 *   address.
 * - `feishu-webhook` — a one-way custom-bot webhook. The URL carries the bot
 *   secret, so only an opaque credential-store REFERENCE is persisted — never
 *   the URL itself, which would leak into logs, exports and sync.
 */
export type NotificationTargetAddress =
  | {
      kind: "connector"
      adapterId: string
      region?: "feishu" | "lark"
      /** Compatibility/index handle for the bound conversation. */
      conversationKey?: string
      deliveryTarget: ConversationDeliveryTarget
      /** Reply anchor when the notification answers an inbound message. */
      replyContext?: { sourceMessageId?: string }
    }
  | {
      kind: "feishu-webhook"
      /** Credential-store reference for the webhook URL (contains the secret). */
      endpointSecretRef: string
      /** Credential-store reference for the optional signature secret. */
      signingSecretRef?: string
      region: "feishu" | "lark"
    }

export interface NotificationTarget {
  id: string
  /** CAS version — bumped on every mutation; address changes replan intents. */
  version: number
  scope: NotificationScope
  /**
   * Denormalized `notificationScopeKey(scope)` — the indexed lookup column.
   * IndexedDB cannot index `scope.*` paths, so the stable key is stored
   * alongside. Writers must keep it in lock-step with `scope` (the DB layer
   * does, via `upsertNotificationTarget`).
   */
  scopeKey: string
  /** Operator-facing label ("#backend-alerts", "on-call webhook"). */
  label: string
  address: NotificationTargetAddress
  /**
   * Canonical fingerprint of the semantic address: adapter instance/account,
   * region, group-or-user and thread/topic — never credentials. Two alias
   * rows with the same fingerprint are ONE destination for delivery slots.
   * For webhook targets the credential layer produces it from the endpoint
   * identity, so the URL secret is never exposed to this table.
   */
  addressFingerprint: string
  enabled: boolean
  /**
   * Numeric projection of `enabled` for the `[scopeKey+enabledKey]` index —
   * IndexedDB cannot index booleans. Writers must keep it in lock-step with
   * `enabled` (the DB layer does, via `upsertNotificationTarget`).
   */
  enabledKey: 0 | 1
  consent: {
    /**
     * `origin-reply` — the target may answer a notification that originated
     * in its own conversation. `proactive` — explicit operator grant for
     * pushes that did not originate there (project digests, ops alerts).
     */
    mode: NotificationTargetConsentMode
    /** Reference to the grant evidence (settings write / approval row id). */
    grantRef: string
    grantedBy: string
    grantedAt: number
  }
  /**
   * Disclosure profile: the maximum classification this target may receive.
   * Content is clipped to the target's ceiling at render, never widened by a
   * higher-priority rule.
   */
  disclosureProfileId: string
  /** BCP-47 locale used to render outbound content for this target. */
  locale: string
  /** IANA timezone for this target's quiet-hours evaluation. */
  timezone: string
  createdAt: number
  updatedAt: number
  /** Soft-delete marker — disabled targets keep their audit trail. */
  deletedAt?: number
}

/** Classification ceiling a target's disclosure profile grants. */
export type NotificationDisclosureLevel = "public" | "internal" | "confidential" | "restricted"

export const NOTIFICATION_DISCLOSURE_RANK: Record<NotificationDisclosureLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export interface NotificationDisclosureProfile {
  id: string
  /** The maximum classification deliverable to this profile. */
  maxLevel: NotificationDisclosureLevel
  /** Whether opaque artifact links (login-gated deep links) may be sent. */
  allowArtifactLinks: boolean
  /** Whether file/media uploads are authorized for this profile. */
  allowAttachments: boolean
  /** Whether a per-target detail entry (deep link) may be rendered. */
  allowDetailLink: boolean
  /** Redact business titles on lock-screen / low-trust surfaces. */
  privacyMode?: boolean
}

/** The built-in disclosure profiles. Operators may register more later. */
export const DEFAULT_DISCLOSURE_PROFILES: readonly NotificationDisclosureProfile[] = [
  {
    id: "public",
    maxLevel: "public",
    allowArtifactLinks: false,
    allowAttachments: false,
    allowDetailLink: true,
    privacyMode: true,
  },
  {
    id: "internal",
    maxLevel: "internal",
    allowArtifactLinks: true,
    allowAttachments: false,
    allowDetailLink: true,
  },
  {
    id: "confidential",
    maxLevel: "confidential",
    allowArtifactLinks: true,
    allowAttachments: true,
    allowDetailLink: true,
  },
  {
    id: "restricted",
    maxLevel: "restricted",
    allowArtifactLinks: true,
    allowAttachments: true,
    allowDetailLink: true,
  },
] as const

export function disclosureProfileById(
  id: string,
  profiles: readonly NotificationDisclosureProfile[] = DEFAULT_DISCLOSURE_PROFILES
): NotificationDisclosureProfile {
  return profiles.find((profile) => profile.id === id) ?? profiles[1] // "internal" — the safe default
}

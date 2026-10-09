// Wire types and validators for remote pet care (ADR-0219).
//
// A paired phone cares for the DESKTOP pet: it reads a mirror of the pet
// tables and sends every action to the host, where the one pet controller
// applies it. These are the shapes that cross that wire, published in
// `protocol/companion-response-schemas.json` (`PetRemote*` defs) and
// `protocol/companion-request-schemas.json` (`pet_*`).
//
// The request parsers run on the host even though the companion server
// validates against the published schema first: the desktop-writes bridge is
// also reachable from a headless brain and from tests, and an arm that trusts
// its payload is how an unvalidated `itemId` became a free item upgrade once
// already (see `spendItem` in `lib/pet/access/gate.ts`).

import type { PetRefusal } from "@/lib/pet/access/gate"
import type { PetUnavailableReason } from "@/lib/pet/access/availability"
import { PET_INTERACTION_KINDS, type PetInteractionKind } from "@/lib/pet/access/limits"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"
import type { PetCondition, PetMood, PetNeeds, PetOneShot, PetStage } from "@/types/pet"

/** Why the host pet cannot be cared for from this device right now. */
export type PetRemoteUnavailableReason =
  | PetUnavailableReason
  /** The host is a headless brain. It has no pet; only a desktop does. */
  | "headless-host"
  /** The desktop has not mounted its pet controller yet (it is booting). */
  | "host-starting"

export type PetRemoteRefusalCode =
  | PetRefusal["code"]
  | "headless-host"
  | "host-starting"
  /** A purchase the balance cannot cover. */
  | "insufficient-coins"
  /** `pet_item_apply` was handed a consumable; those go through `pet_act`. */
  | "not-decor"
  /** A rename that is blank after sanitizing, or a pet with no soul to rename. */
  | "invalid-name"
  /** Soul generation failed on the host. */
  | "hatch-failed"

/**
 * `PetRefusal` as it crosses the wire: the same codes, flattened, without the
 * rate limiter's `cause` (an Error object, which neither serializes nor means
 * anything to a phone).
 */
export interface PetRemoteRefusal {
  code: PetRemoteRefusalCode
  reason?: PetRemoteUnavailableReason
  kind?: string
  itemId?: string
  itemKind?: string
  retryAfterMs?: number
}

export interface PetRemoteRefused {
  ok: false
  refusal: PetRemoteRefusal
}

export interface PetRemoteSummary {
  hatched: boolean
  name: string | null
  level: number
  stage: PetStage
  xp: number
  mood: PetMood
  needs: Pick<PetNeeds, "energy" | "mood" | "bond">
  condition: PetCondition
  coins: number
  streak: { days: number; lastDay: string | null; multiplier: number }
  /** Ms until each care action is accepted again on the host clock; 0 = ready. */
  cooldowns: Record<string, number>
}

export interface PetRemotePresentation {
  /** The skin the desktop asked for; a phone may render a simplified look. */
  requestedSkinId: string
  /** The desktop overlay pet is out. */
  desktopVisible: boolean
  llmSpeakEnabled: boolean
  /** A chat turn can produce a real reply: LLM speak on and the pet hatched. */
  chatEnabled: boolean
}

export interface PetRemoteSnapshot {
  availability: { available: true } | { available: false; reason: PetRemoteUnavailableReason }
  /** Null until the host has a pet profile. */
  summary: PetRemoteSummary | null
  /** Null on a headless brain, which has no pet settings to present. */
  presentation: PetRemotePresentation | null
  /** The host clock when the snapshot was taken, so cooldowns can be aged. */
  hostTime: number
}

export type PetActResult = { ok: true; grantedXp: number; grantedCoins: number } | PetRemoteRefused
export type PetRenameResult = { ok: true; name: string } | PetRemoteRefused
export type PetPurchaseResult = { ok: true; coins: number } | PetRemoteRefused
export type PetApplyResult = { ok: true } | PetRemoteRefused
export type PetHatchResult =
  { ok: true; state: "hatched" | "pending" | "already-hatched" } | PetRemoteRefused
export type PetChatSendResult =
  | { ok: true; status: "replied"; reply: string; emotion?: PetOneShot }
  | { ok: true; status: "degraded"; reason: PetChatDegradeReason }
  /** The reply outlived the bridge window; it lands in the history on its own. */
  | { ok: true; status: "pending" }
  | PetRemoteRefused
export type PetChatClearResult = { ok: true } | PetRemoteRefused

export interface PetRemoteChatTurn {
  id: string
  at: number
  userText: string
  reply: string
}

export interface PetChatListResult {
  items: PetRemoteChatTurn[]
  nextPageToken?: string
}

/** Flatten a gate refusal for the wire. */
export function toRemoteRefusal(refusal: PetRefusal): PetRemoteRefusal {
  switch (refusal.code) {
    case "unavailable":
      return { code: "unavailable", reason: refusal.reason }
    case "rate-limited":
      return { code: "rate-limited" }
    case "kind-not-allowed":
      return { code: "kind-not-allowed", kind: refusal.kind }
    case "unknown-item":
    case "item-not-owned":
      return { code: refusal.code, itemId: refusal.itemId }
    case "item-kind-mismatch":
      return {
        code: "item-kind-mismatch",
        itemId: refusal.itemId,
        kind: refusal.kind,
        ...(refusal.itemKind ? { itemKind: refusal.itemKind } : {}),
      }
    case "cooling-down":
      return { code: "cooling-down", kind: refusal.kind, retryAfterMs: refusal.retryAfterMs }
    case "uninitialized":
    case "not-hatched":
      return { code: refusal.code }
  }
}

export function refused(refusal: PetRemoteRefusal): PetRemoteRefused {
  return { ok: false, refusal }
}

// ── Request parsing (host side) ──────────────────────────────────────────────

/** Mirrors the request schema's `idempotencyKey` bounds. */
export const PET_IDEMPOTENCY_KEY_MAX = 128
/** Mirrors the request schema's `itemId` bound. */
export const PET_ITEM_ID_MAX = 80
/** Raw rename input; the host sanitizes and clamps to `MAX_PET_NAME`. */
export const PET_RENAME_INPUT_MAX = 64
/** Mirrors the talk composer's limit. */
export const PET_CHAT_TEXT_MAX = 500
export const PET_PURCHASE_QTY_MAX = 99
export const PET_CHAT_PAGE_SIZE_MAX = 200
export const PET_CHAT_PAGE_SIZE_DEFAULT = 50
export const PET_CHAT_LOCALES = ["en", "zh-CN"] as const
export type PetChatLocale = (typeof PET_CHAT_LOCALES)[number]

const INTERACTION_KINDS: ReadonlySet<string> = new Set(PET_INTERACTION_KINDS)

function boundedString(payload: Record<string, unknown>, key: string, max: number): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`)
  if (value.length > max) throw new Error(`${key} exceeds ${max} characters`)
  return value
}

function optionalBoundedString(
  payload: Record<string, unknown>,
  key: string,
  max: number
): string | undefined {
  if (payload[key] === undefined) return undefined
  return boundedString(payload, key, max)
}

/** The authenticated caller, injected by the companion server, never the client. */
export function parseCallerDeviceId(payload: Record<string, unknown>): string {
  return boundedString(payload, "callerDeviceId", 512)
}

export function parseIdempotencyKey(payload: Record<string, unknown>): string {
  return boundedString(payload, "idempotencyKey", PET_IDEMPOTENCY_KEY_MAX)
}

export function parsePetActRequest(payload: Record<string, unknown>): {
  action: PetInteractionKind
  itemId?: string
} {
  const action = payload.action
  if (typeof action !== "string" || !INTERACTION_KINDS.has(action)) {
    throw new Error("action must be one of " + PET_INTERACTION_KINDS.join(", "))
  }
  const itemId = optionalBoundedString(payload, "itemId", PET_ITEM_ID_MAX)
  return { action: action as PetInteractionKind, ...(itemId ? { itemId } : {}) }
}

export function parsePetPurchaseRequest(payload: Record<string, unknown>): {
  itemId: string
  qty: number
} {
  const itemId = boundedString(payload, "itemId", PET_ITEM_ID_MAX)
  const qty = payload.qty
  if (
    typeof qty !== "number" ||
    !Number.isSafeInteger(qty) ||
    qty < 1 ||
    qty > PET_PURCHASE_QTY_MAX
  ) {
    throw new Error(`qty must be an integer from 1 to ${PET_PURCHASE_QTY_MAX}`)
  }
  return { itemId, qty }
}

export function parsePetApplyRequest(payload: Record<string, unknown>): { itemId: string } {
  return { itemId: boundedString(payload, "itemId", PET_ITEM_ID_MAX) }
}

export function parsePetRenameRequest(payload: Record<string, unknown>): { name: string } {
  return { name: boundedString(payload, "name", PET_RENAME_INPUT_MAX) }
}

export function parsePetChatSendRequest(payload: Record<string, unknown>): {
  text: string
  locale: PetChatLocale
} {
  const text = boundedString(payload, "text", PET_CHAT_TEXT_MAX)
  const locale = payload.locale
  if (typeof locale !== "string" || !(PET_CHAT_LOCALES as readonly string[]).includes(locale)) {
    throw new Error("locale must be one of " + PET_CHAT_LOCALES.join(", "))
  }
  return { text, locale: locale as PetChatLocale }
}

const PAGE_TOKEN_PREFIX = "pc:"

/** Opaque to the client: the offset from the newest turn. */
export function encodeChatPageToken(offset: number): string {
  return `${PAGE_TOKEN_PREFIX}${offset}`
}

export function parsePetChatListRequest(payload: Record<string, unknown>): {
  pageSize: number
  offset: number
} {
  const rawSize = payload.pageSize
  let pageSize = PET_CHAT_PAGE_SIZE_DEFAULT
  if (rawSize !== undefined) {
    if (
      typeof rawSize !== "number" ||
      !Number.isSafeInteger(rawSize) ||
      rawSize < 1 ||
      rawSize > PET_CHAT_PAGE_SIZE_MAX
    ) {
      throw new Error(`pageSize must be an integer from 1 to ${PET_CHAT_PAGE_SIZE_MAX}`)
    }
    pageSize = rawSize
  }
  let offset = 0
  const token = payload.pageToken
  if (token !== undefined) {
    if (typeof token !== "string" || !token.startsWith(PAGE_TOKEN_PREFIX)) {
      throw new Error("pageToken is not a token this host issued")
    }
    const parsed = Number(token.slice(PAGE_TOKEN_PREFIX.length))
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error("pageToken is not a token this host issued")
    }
    offset = parsed
  }
  return { pageSize, offset }
}

// ── Response validation (client side) ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * Whether a host answer is a usable snapshot. The phone renders from this, so
 * a malformed answer (an older host, a broken bridge) is treated as "no
 * snapshot" rather than painted half-filled.
 */
export function isPetRemoteSnapshot(value: unknown): value is PetRemoteSnapshot {
  if (!isRecord(value)) return false
  const availability = value.availability
  if (!isRecord(availability) || typeof availability.available !== "boolean") return false
  if (!availability.available && typeof availability.reason !== "string") return false
  if (!isNonNegativeNumber(value.hostTime)) return false
  if (value.presentation !== null && !isRecord(value.presentation)) return false
  const summary = value.summary
  if (summary === null) return true
  if (!isRecord(summary)) return false
  return (
    typeof summary.hatched === "boolean" &&
    (summary.name === null || typeof summary.name === "string") &&
    typeof summary.level === "number" &&
    typeof summary.stage === "string" &&
    isNonNegativeNumber(summary.xp) &&
    isNonNegativeNumber(summary.coins) &&
    isRecord(summary.needs) &&
    isRecord(summary.streak) &&
    isRecord(summary.cooldowns)
  )
}

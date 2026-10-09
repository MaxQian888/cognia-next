// The one place an outside caller asks to drive the pet.
//
// Three call sites used to reach `emitPetEvent` with three different amounts
// of checking: the plugin API had a token bucket and a daily ledger, the
// command registry (tray quick actions, global hotkeys) had nothing at all,
// and the overlay's body-tap had nothing either. Adding the agent as a fourth
// caller under the plugin module would have made `lib/plugin/api` the de-facto
// owner of pet policy, so the gate lives with the pet instead and the plugin
// API is now one of its callers.
//
// What this layer is NOT: it is not the cooldown. A caller can go around any
// API by posting on the cross-window bridge, so the per-kind cooldown belongs
// to the controller, which is the single serialized writer and sees every
// path. This layer answers the questions a caller deserves a real answer to
// (may I act here, is this kind allowed, am I over my burst, do I own that
// item, what is my remaining allowance) and returns a result instead of
// emitting into the dark.

import type { PetEventKind } from "@/types/pet"
import type { Platform } from "@/lib/platform/detect"
import type { PetWindowRole } from "@/lib/pet/window-role"
import type { PetProfile } from "@/types/pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { decrementPetInventory, getPetProfile } from "@/lib/db/pet"
import {
  INTERACTION_COOLDOWN_MS,
  normalizeInteractionGate,
  remainingCooldownMs,
} from "@/lib/pet/interaction/gate"
import { XP_AWARD } from "@/lib/pet/xp/award-table"
import { COIN_AWARD } from "@/lib/pet/economy/coin-table"
import { getPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import {
  resolveLivePetAvailability,
  type PetUnavailableReason,
} from "@/lib/pet/access/availability"
import { consumePetBudget, getRemainingPetBudget } from "@/lib/pet/access/reward-budget"
import {
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  PET_INTERACTION_KINDS,
  PET_REWARDABLE_KINDS,
  type PetInteractionKind,
  type PetRewardableKind,
} from "@/lib/pet/access/limits"

/**
 * Who is asking.
 *
 * `user` is a human acting through the UI, the tray, or a hotkey. It is exempt
 * from the daily ledger because a person clicking is not the abuse vector the
 * ledger exists for, and because its events must keep falling through to the
 * host award tables exactly as they did before this gate existed. The bound on
 * a human is the controller's cooldown.
 *
 * `plugin` and `agent` are third-party or automated drivers and both spend the
 * ledger. The agent spends under one identity rather than per session, or every
 * new chat would hand it a fresh allowance.
 */
export type PetAccessSubjectKind = "user" | "plugin" | "agent"

export interface PetAccessSubject {
  kind: PetAccessSubjectKind
  /** Plugin id for `plugin`. Ignored for `user` and `agent`. */
  id?: string
}

export type PetRefusal =
  | { code: "unavailable"; reason: PetUnavailableReason }
  /** `cause` is the limiter's own error, so a caller with a throwing
   *  contract can rethrow it unchanged instead of inventing a new one. */
  | { code: "rate-limited"; cause?: unknown }
  | { code: "kind-not-allowed"; kind: string }
  | { code: "unknown-item"; itemId: string }
  | { code: "item-not-owned"; itemId: string }
  /** The item exists but is for a different interaction (food is not a pat). */
  | { code: "item-kind-mismatch"; itemId: string; kind: string; itemKind?: string }
  /** No pet profile exists on this device yet. */
  | { code: "uninitialized" }
  /** The pet is still an egg; nurturing it would do nothing. */
  | { code: "not-hatched" }
  /** The controller would drop this action: it is still cooling down. */
  | { code: "cooling-down"; kind: string; retryAfterMs: number }

/**
 * Reduce a caller's free-form meta to the id-shaped whitelist.
 *
 * This used to live in `pet-api.ts`, applied immediately before its own
 * `emitPetEvent`. Moving the emit into this gate left the sanitizer behind at
 * one caller, which made the gate's `meta` parameter an unfiltered path onto
 * the bus for the three callers that arrived after it. Whatever emits should
 * be what sanitizes.
 */
function sanitizeEventMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {}
  const out: Record<string, unknown> = {}
  if (typeof meta.achievementId === "string") out.achievementId = meta.achievementId
  if (typeof meta.itemId === "string") out.itemId = meta.itemId
  if (typeof meta.goalId === "string") out.goalId = meta.goalId
  if (typeof meta.level === "number") out.level = meta.level
  if (typeof meta.stage === "string") out.stage = meta.stage
  return out
}

export type PetAccessResult =
  { ok: true; grantedXp: number; grantedCoins: number } | { ok: false; refusal: PetRefusal }

export {
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  PET_INTERACTION_KINDS,
  PET_REWARDABLE_KINDS,
  type PetInteractionKind,
  type PetRewardableKind,
}

const INTERACTION_KIND_SET: ReadonlySet<string> = new Set(PET_INTERACTION_KINDS)

/** Narrows a caller's string once, so the award tables can be indexed safely. */
function isPetInteractionKind(kind: string): kind is PetInteractionKind {
  return INTERACTION_KIND_SET.has(kind)
}

const REWARDABLE_KIND_SET: ReadonlySet<string> = new Set(PET_REWARDABLE_KINDS)

export interface PetAccessDeps {
  now?: () => number
  /** `PetSettings.enabled`. Defaults to the live settings store. */
  isEnabled?: () => boolean
  role?: PetWindowRole
  platform?: Platform
  rateLimiter?: { check: (subjectKey: string, operation: string) => void }
  emit?: typeof emitPetEvent
  decrementInventory?: (id: string, qty?: number) => Promise<boolean>
  /** Reads the durable profile for the advisory controller check. */
  getProfile?: () => Promise<PetProfile | undefined | null>
}

/** Subject kinds whose ledger keys a plugin id must never land on. */
const NON_PLUGIN_SUBJECT_KEYS: ReadonlySet<string> = new Set(["user", "agent", "plugin"])

/**
 * Ledger and bucket key. Plugins keep their bare id so an in-flight day's
 * ledger and the existing per-plugin buckets survive this refactor unchanged,
 * except an id that spells another subject's key ("user", "agent" are valid
 * plugin ids): those are namespaced, or that plugin would share the agent's
 * daily ledger and burst bucket.
 */
export function petSubjectKey(subject: PetAccessSubject): string {
  if (subject.kind === "plugin") {
    const id = subject.id ?? "plugin"
    return NON_PLUGIN_SUBJECT_KEYS.has(id) ? `plugin:${id}` : id
  }
  return subject.kind
}

function readEnabled(deps: PetAccessDeps): boolean {
  if (deps.isEnabled) return deps.isEnabled()
  const settings = useSettingsStore.getState().settings
  return (settings?.petSettings ?? DEFAULT_PET_SETTINGS).enabled
}

function checkAvailability(deps: PetAccessDeps): PetRefusal | null {
  const availability = resolveLivePetAvailability(readEnabled(deps), {
    role: deps.role,
    platform: deps.platform,
  })
  return availability.available ? null : { code: "unavailable", reason: availability.reason }
}

function checkBurst(subjectKey: string, operation: string, deps: PetAccessDeps): PetRefusal | null {
  const limiter = deps.rateLimiter ?? getPluginRateLimiter()
  try {
    limiter.check(subjectKey, operation)
    return null
  } catch (err) {
    return { code: "rate-limited", cause: err }
  }
}

/**
 * Spend an item the subject claims to be using.
 *
 * `applyPetEvent` reads `meta.itemId` and applies that item's stronger
 * `needsEffect` in place of the base interaction restore, so an unowned id was
 * a free upgrade: the shop path checks ownership and decrements, and this path
 * did neither. Refusing rather than quietly dropping the id keeps the caller
 * honest about what it asked for. An item is spent only on the interaction it
 * is for, so nobody pays for food that a `petted` event would then ignore.
 */
async function spendItem(
  itemId: string,
  kind: PetInteractionKind,
  deps: PetAccessDeps
): Promise<PetRefusal | null> {
  const item = getPetItem(itemId)
  if (!item || !item.consumable) return { code: "unknown-item", itemId }
  if (item.interactionKind !== kind) {
    return { code: "item-kind-mismatch", itemId, kind, itemKind: item.interactionKind }
  }
  const decrement = deps.decrementInventory ?? decrementPetInventory
  const consumed = await decrement(itemId, 1)
  return consumed ? null : { code: "item-not-owned", itemId }
}

/**
 * Ask the controller's own durable state whether it would accept a driven
 * nurture of `kind` right now, BEFORE anything is spent.
 *
 * The controller stays the authority (it re-checks on the event), but it can
 * only drop an event after the fact: the ledger was already charged, the item
 * already decremented, and the caller already told it was granted rewards that
 * were never applied. Kinds without a cooldown are ambient and pass.
 *
 * Exported without a subject because spending is what makes the precheck
 * necessary, not who is asking: the shop's `consumeItem` is a `user` action
 * and still loses the item when the controller then drops its event.
 */
export async function checkInteractionAccepted(
  kind: string,
  deps: Pick<PetAccessDeps, "getProfile" | "now"> = {}
): Promise<PetRefusal | null> {
  if (INTERACTION_COOLDOWN_MS[kind] === undefined) return null
  const profile = await (deps.getProfile ?? getPetProfile)()
  if (!profile) return { code: "uninitialized" }
  if (!profile.soul) return { code: "not-hatched" }
  const now = (deps.now ?? Date.now)()
  const retryAfterMs = remainingCooldownMs(
    normalizeInteractionGate(profile.interactionGate),
    kind,
    now
  )
  return retryAfterMs > 0 ? { code: "cooling-down", kind, retryAfterMs } : null
}

/**
 * The subject-aware form. A `user` subject is exempt, as from the ledger: its
 * refusal is answered by the controller's own cooldown bubble, unless it is
 * about to spend an item, which the bubble cannot give back.
 */
async function checkControllerWouldAccept(
  subject: PetAccessSubject,
  kind: string,
  deps: PetAccessDeps,
  spendsItem = false
): Promise<PetRefusal | null> {
  if (subject.kind === "user" && !spendsItem) return null
  return checkInteractionAccepted(kind, deps)
}

/** Remaining daily reward allowance for a subject. */
export function remainingPetAllowance(subject: PetAccessSubject): { xp: number; coins: number } {
  if (subject.kind === "user") {
    return { xp: Number.POSITIVE_INFINITY, coins: Number.POSITIVE_INFINITY }
  }
  return getRemainingPetBudget(petSubjectKey(subject))
}

/**
 * Drive a nurture interaction.
 *
 * A `user` subject emits exactly the event the command registry emitted before
 * this gate existed, with no explicit overrides, so the host award tables still
 * apply. Every other subject spends the daily ledger and rides the granted
 * amounts on the event as explicit overrides (even zero), so a drained budget
 * can never fall back through to those tables.
 */
export async function requestPetInteraction(
  subject: PetAccessSubject,
  kind: string,
  opts: { itemId?: string } = {},
  deps: PetAccessDeps = {}
): Promise<PetAccessResult> {
  const unavailable = checkAvailability(deps)
  if (unavailable) return { ok: false, refusal: unavailable }
  if (!isPetInteractionKind(kind)) {
    return { ok: false, refusal: { code: "kind-not-allowed", kind } }
  }

  const subjectKey = petSubjectKey(subject)
  const limited = checkBurst(subjectKey, "pet:interact", deps)
  if (limited) return { ok: false, refusal: limited }

  // Not awaited for a bare `user` subject (exempt anyway): a hotkey's event
  // still reaches the bus in the same tick, the way the command registry
  // always did. A user spending an item waits, because a dropped event would
  // otherwise cost them the item.
  if (subject.kind !== "user" || opts.itemId) {
    const notNow = await checkControllerWouldAccept(subject, kind, deps, Boolean(opts.itemId))
    if (notNow) return { ok: false, refusal: notNow }
  }

  if (opts.itemId) {
    const itemRefusal = await spendItem(opts.itemId, kind, deps)
    if (itemRefusal) return { ok: false, refusal: itemRefusal }
  }

  const emit = deps.emit ?? emitPetEvent
  const meta: Record<string, unknown> = {}
  if (subject.kind === "plugin" && subject.id) meta.pluginId = subject.id
  if (opts.itemId) meta.itemId = opts.itemId

  if (subject.kind === "user") {
    emit({
      source: "user",
      kind,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    })
    return { ok: true, grantedXp: XP_AWARD[kind] ?? 0, grantedCoins: COIN_AWARD[kind] ?? 0 }
  }

  const { grantedXp, grantedCoins } = consumePetBudget(subjectKey, {
    xp: XP_AWARD[kind] ?? 0,
    coins: COIN_AWARD[kind] ?? 0,
  })
  emit({
    source: subject.kind === "agent" ? "system" : "plugin",
    kind,
    xp: grantedXp,
    meta: { ...meta, coins: grantedCoins },
  })
  return { ok: true, grantedXp, grantedCoins }
}

/**
 * Grant a milestone reward for a whitelisted kind. Amounts are clamped per call
 * and against the daily ledger rather than rejected, so an exhausted budget is
 * a successful call that granted zero.
 *
 * A reward never consumes an item, so it never carries one either: the
 * sanitized meta drops `itemId`. Before that, `emitEvent("fed", { meta: {
 * itemId } })` applied a premium item's restore without owning or spending it,
 * the very upgrade `requestPetInteraction` refuses.
 */
export async function requestPetReward(
  subject: PetAccessSubject,
  kind: PetEventKind,
  opts: { xp?: number; coins?: number; meta?: Record<string, unknown> } = {},
  deps: PetAccessDeps = {}
): Promise<PetAccessResult> {
  const unavailable = checkAvailability(deps)
  if (unavailable) return { ok: false, refusal: unavailable }
  if (!REWARDABLE_KIND_SET.has(kind)) {
    return { ok: false, refusal: { code: "kind-not-allowed", kind } }
  }

  const subjectKey = petSubjectKey(subject)
  // A care kind drives the pet exactly like `requestPetInteraction`, so it is
  // limited by the same (stricter) bucket rather than the reward bucket.
  const bucket = isPetInteractionKind(kind) ? "pet:interact" : "pet:emit"
  const limited = checkBurst(subjectKey, bucket, deps)
  if (limited) return { ok: false, refusal: limited }

  const notNow = await checkControllerWouldAccept(subject, kind, deps)
  if (notNow) return { ok: false, refusal: notNow }

  const askXp = Math.min(MAX_XP_PER_REWARD, Math.max(0, Math.floor(opts.xp ?? 0)))
  const askCoins = Math.min(MAX_COINS_PER_REWARD, Math.max(0, Math.floor(opts.coins ?? 0)))
  // A `user` subject is exempt from the daily ledger here for the same reason
  // it is exempt in `requestPetInteraction`, and because
  // `remainingPetAllowance` already reports an unbounded allowance for one.
  // Spending a ledger this side claims is infinite would make the two disagree.
  const { grantedXp, grantedCoins } =
    subject.kind === "user"
      ? { grantedXp: askXp, grantedCoins: Math.max(0, Math.floor(opts.coins ?? 0)) }
      : consumePetBudget(subjectKey, { xp: askXp, coins: askCoins })
  const emit = deps.emit ?? emitPetEvent
  const { itemId: _droppedItemId, ...rewardMeta } = sanitizeEventMeta(opts.meta)
  const meta: Record<string, unknown> = { ...rewardMeta, coins: grantedCoins }
  if (subject.kind === "plugin" && subject.id) meta.pluginId = subject.id
  emit({
    source: subject.kind === "agent" ? "system" : "plugin",
    kind,
    xp: grantedXp,
    meta,
  })
  return { ok: true, grantedXp, grantedCoins }
}

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
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { decrementPetInventory } from "@/lib/db/pet"
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

export type PetAccessResult =
  { ok: true; grantedXp: number; grantedCoins: number } | { ok: false; refusal: PetRefusal }

/** Nurture kinds any subject may drive directly. */
export const PET_INTERACTION_KINDS = [
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
] as const
export type PetInteractionKind = (typeof PET_INTERACTION_KINDS)[number]

const INTERACTION_KIND_SET: ReadonlySet<string> = new Set(PET_INTERACTION_KINDS)

/** Kinds a non-user subject may reward through {@link requestPetReward}. */
export const PET_REWARDABLE_KINDS: readonly PetEventKind[] = [
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
  "workflowRun",
]

/** Hard per-call XP ceiling, below the daily budget. */
export const MAX_XP_PER_REWARD = 10

export interface PetAccessDeps {
  now?: () => number
  /** `PetSettings.enabled`. Defaults to the live settings store. */
  isEnabled?: () => boolean
  role?: PetWindowRole
  platform?: Platform
  rateLimiter?: { check: (subjectKey: string, operation: string) => void }
  emit?: typeof emitPetEvent
  decrementInventory?: (id: string, qty?: number) => Promise<boolean>
}

/**
 * Ledger and bucket key. Plugins keep their bare id so an in-flight day's
 * ledger and the existing per-plugin buckets survive this refactor unchanged.
 */
export function petSubjectKey(subject: PetAccessSubject): string {
  if (subject.kind === "plugin") return subject.id ?? "plugin"
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
 * honest about what it asked for.
 */
async function spendItem(itemId: string, deps: PetAccessDeps): Promise<PetRefusal | null> {
  const item = getPetItem(itemId)
  if (!item || !item.consumable) return { code: "unknown-item", itemId }
  const decrement = deps.decrementInventory ?? decrementPetInventory
  const consumed = await decrement(itemId, 1)
  return consumed ? null : { code: "item-not-owned", itemId }
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
  if (!INTERACTION_KIND_SET.has(kind)) {
    return { ok: false, refusal: { code: "kind-not-allowed", kind } }
  }

  const subjectKey = petSubjectKey(subject)
  const limited = checkBurst(subjectKey, "pet:interact", deps)
  if (limited) return { ok: false, refusal: limited }

  if (opts.itemId) {
    const itemRefusal = await spendItem(opts.itemId, deps)
    if (itemRefusal) return { ok: false, refusal: itemRefusal }
  }

  const emit = deps.emit ?? emitPetEvent
  const meta: Record<string, unknown> = {}
  if (subject.kind === "plugin" && subject.id) meta.pluginId = subject.id
  if (opts.itemId) meta.itemId = opts.itemId

  if (subject.kind === "user") {
    emit({
      source: "user",
      kind: kind as PetEventKind,
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
    kind: kind as PetEventKind,
    xp: grantedXp,
    meta: { ...meta, coins: grantedCoins },
  })
  return { ok: true, grantedXp, grantedCoins }
}

/**
 * Grant a milestone reward for a whitelisted kind. Amounts are clamped per call
 * and against the daily ledger rather than rejected, so an exhausted budget is
 * a successful call that granted zero.
 */
export async function requestPetReward(
  subject: PetAccessSubject,
  kind: PetEventKind,
  opts: { xp?: number; coins?: number; meta?: Record<string, unknown> } = {},
  deps: PetAccessDeps = {}
): Promise<PetAccessResult> {
  const unavailable = checkAvailability(deps)
  if (unavailable) return { ok: false, refusal: unavailable }
  if (!PET_REWARDABLE_KINDS.includes(kind)) {
    return { ok: false, refusal: { code: "kind-not-allowed", kind } }
  }

  const subjectKey = petSubjectKey(subject)
  const limited = checkBurst(subjectKey, "pet:emit", deps)
  if (limited) return { ok: false, refusal: limited }

  const askXp = Math.min(MAX_XP_PER_REWARD, Math.max(0, Math.floor(opts.xp ?? 0)))
  const { grantedXp, grantedCoins } = consumePetBudget(subjectKey, {
    xp: askXp,
    coins: opts.coins,
  })
  const emit = deps.emit ?? emitPetEvent
  const meta: Record<string, unknown> = { ...opts.meta, coins: grantedCoins }
  if (subject.kind === "plugin" && subject.id) meta.pluginId = subject.id
  emit({
    source: subject.kind === "agent" ? "system" : "plugin",
    kind,
    xp: grantedXp,
    meta,
  })
  return { ok: true, grantedXp, grantedCoins }
}

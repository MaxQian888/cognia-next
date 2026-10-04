// Plugin-facing desktop-pet API (ctx.pet). This module owns what is a PLUGIN
// concern and delegates what is a PET concern.
//
// Plugin concerns kept here:
//   1. Capability gate. Without the `"pet"` capability every method is a
//      warn-once no-op (tray-api pattern), so ctx.pet never throws for
//      plugins that simply did not opt in.
//   2. Permission guard. Reads need `pet:read`, interactions and rewards need
//      `pet:interact` (fail-closed `createGuardedAPI` proxy).
//   3. Event sanitization on the way out to subscribers.
//   4. The throwing contract plugin authors already code against.
//
// Pet policy now lives in `lib/pet/access/gate.ts`, which the command
// registry and the agent tools call too. Before that gate existed this file
// was the only caller doing any checking at all, which made it the de-facto
// owner of rules that were never enforced on the three other paths into the
// same event bus.
//
// PII red-line: the summary never exposes accountFingerprint/bones/soul
// internals, and forwarded events carry a REDUCED meta (id-shaped keys only,
// so a `talked` event's meta.userText never crosses into plugin code).

import { loggers } from "@cognia/logging"
import type { PluginCapability } from "@/types/plugin/plugin"
import { getPetProfile } from "@/lib/db/pet"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { resolveLivePetAvailability } from "@/lib/pet/access/availability"
import { useSettingsStore } from "@/stores/settings"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { projectPetSummary, type PetSummary } from "@/lib/pet/access/summary"
import {
  remainingPetAllowance,
  requestPetInteraction,
  requestPetReward,
  type PetAccessResult,
  type PetInteractionKind,
} from "@/lib/pet/access/gate"
import {
  PetCooldownError,
  PetEventKindNotAllowedError,
  PetItemKindMismatchError,
  PetItemNotOwnedError,
  type PluginEmittablePetEventKind,
  type PluginPetAvailability,
  type PluginPetEvent,
} from "./pet-api-contract"

export {
  MAX_COINS_PER_EMIT,
  MAX_XP_PER_EMIT,
  PLUGIN_EMITTABLE_PET_EVENT_KINDS,
  PetCooldownError,
  PetEventKindNotAllowedError,
  PetItemKindMismatchError,
  PetItemNotOwnedError,
  type PluginEmittablePetEventKind,
  type PluginPetAvailability,
  type PluginPetEvent,
  type PluginPetUnavailableReason,
} from "./pet-api-contract"

/**
 * PII-safe projection of the pet's public state.
 *
 * The shape moved to `lib/pet/access/summary.ts` when the agent gained the
 * same read. The alias stays because the SDK re-exports this name from this
 * path (`packages/plugin-sdk/src/api/pet.ts`), so renaming it here would break
 * every plugin that imports the type.
 */
export type PluginPetSummary = PetSummary

/** Direct nurture interactions a plugin may perform. */
export type PluginPetInteractionKind = PetInteractionKind

/**
 * The permission each method requires. The single source for the guard
 * below, and pinned against the published contract catalog by a parity test,
 * so the catalog (and everything generated from it: the SDK reference, the
 * Python and Rust mirrors, the audit view) cannot drift from what the host
 * actually enforces.
 */
export const PET_API_PERMISSIONS = {
  getView: "pet:read",
  getSummary: "pet:read",
  getAvailability: "pet:read",
  onEvent: "pet:read",
  getRemainingBudget: "pet:read",
  interact: "pet:interact",
  emitEvent: "pet:interact",
} as const satisfies Record<keyof PluginPetAPI, string>

export interface PluginPetAPI {
  /** Live public view of the pet (null before the profile is initialized). */
  getView(): Promise<PluginPetSummary | null>
  /** Alias of getView — kept separate so a richer projection can grow later. */
  getSummary(): Promise<PluginPetSummary | null>
  /** Subscribe to sanitized pet events. Returns a disposer. */
  onEvent(cb: (event: PluginPetEvent) => void): () => void
  /**
   * Whether interactions and rewards would reach the pet right now, and if
   * not, why. A pet that is switched off, still an egg, or not set up yet
   * makes `interact`/`emitEvent` grant zero quietly; ask this first so a quest
   * is not marked claimed for a reward the pet never received.
   */
  getAvailability(): Promise<PluginPetAvailability>
  /** Remaining daily reward budget for THIS plugin (for quest UIs). */
  getRemainingBudget(): { xp: number; coins: number }
  /**
   * Emit a direct nurture interaction (rate-limited). The kind's host award
   * amounts are spent from the SAME daily budget as `emitEvent`. At zero
   * remaining budget the interaction still settles needs/mood and plays its
   * flourish, it just grants nothing. Returns what was actually granted.
   *
   * Throws `PetCooldownError` while the pet is recovering from the same action
   * (nothing is spent), `PetItemNotOwnedError` for an item this plugin's user
   * does not own, and `PetItemKindMismatchError` for an item that is not for
   * this action.
   */
  interact(
    kind: PluginPetInteractionKind,
    opts?: { itemId?: string }
  ): Promise<{ grantedXp: number; grantedCoins: number }>
  /**
   * Emit a whitelisted event with an optional XP/coin reward, clamped per
   * call (`MAX_XP_PER_EMIT`, `MAX_COINS_PER_EMIT`) and against the daily
   * budget. Returns what was actually granted. Use `pluginReward` for a
   * reward that is not itself a care action. A reward never carries an item.
   * A care kind throws `PetCooldownError` while it is cooling.
   */
  emitEvent(
    kind: PluginEmittablePetEventKind,
    opts?: { xp?: number; coins?: number; meta?: Record<string, unknown> }
  ): Promise<{ grantedXp: number; grantedCoins: number }>
}

interface CreatePetAPIArgs {
  pluginId: string
  capabilities: readonly PluginCapability[]
}

/** Reduce an event's free-form meta to the id-shaped whitelist. */
function sanitizeMeta(meta: Record<string, unknown> | undefined): PluginPetEvent["meta"] {
  if (!meta) return undefined
  const out: NonNullable<PluginPetEvent["meta"]> = {}
  if (typeof meta.achievementId === "string") out.achievementId = meta.achievementId
  if (typeof meta.itemId === "string") out.itemId = meta.itemId
  if (typeof meta.goalId === "string") out.goalId = meta.goalId
  if (typeof meta.level === "number") out.level = meta.level
  if (typeof meta.stage === "string") out.stage = meta.stage
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Turn a gate result into the contract plugin authors already code against.
 *
 * A refusal that is the plugin's fault throws, the way it always has. A pet
 * that is simply switched off is NOT the plugin's fault, so that grants
 * nothing and returns quietly, matching how the capability gate behaves for a
 * plugin that never opted in.
 */
function unwrap(result: PetAccessResult): { grantedXp: number; grantedCoins: number } {
  if (result.ok) return { grantedXp: result.grantedXp, grantedCoins: result.grantedCoins }
  const { refusal } = result
  switch (refusal.code) {
    case "kind-not-allowed":
      throw new PetEventKindNotAllowedError(refusal.kind)
    case "unknown-item":
    case "item-not-owned":
      throw new PetItemNotOwnedError(refusal.itemId)
    case "item-kind-mismatch":
      throw new PetItemKindMismatchError(refusal.itemId, refusal.kind, refusal.itemKind)
    case "rate-limited":
      throw refusal.cause instanceof Error ? refusal.cause : new Error("Pet rate limit exceeded")
    case "cooling-down":
      throw new PetCooldownError(refusal.kind, refusal.retryAfterMs)
    // The pet's own state, not the plugin's fault: quiet, like a switched-off
    // pet. `getAvailability()` is how a plugin tells these apart from a grant.
    case "unavailable":
    case "uninitialized":
    case "not-hatched":
      return { grantedXp: 0, grantedCoins: 0 }
  }
}

/** Host + pet availability, the way the access gate answers it. */
async function readAvailability(): Promise<PluginPetAvailability> {
  const enabled = useSettingsStore.getState().settings?.petSettings?.enabled !== false
  const host = resolveLivePetAvailability(enabled)
  if (!host.available) return { available: false, reason: host.reason }
  const profile = await getPetProfile()
  if (!profile) return { available: false, reason: "uninitialized" }
  if (!profile.soul) return { available: false, reason: "not-hatched" }
  return { available: true }
}

export function createPetAPI({ pluginId, capabilities }: CreatePetAPIArgs): PluginPetAPI {
  if (!capabilities.includes("pet")) return noopPetAPI(pluginId)

  const api: PluginPetAPI = {
    getView: async () => {
      const profile = await getPetProfile()
      return profile ? projectPetSummary(profile, Date.now()) : null
    },
    getSummary: async () => {
      const profile = await getPetProfile()
      return profile ? projectPetSummary(profile, Date.now()) : null
    },
    getAvailability: () => readAvailability(),
    onEvent: (cb) =>
      getPetEventBus().subscribe((event) => {
        try {
          cb({
            source: event.source,
            kind: event.kind,
            ...(typeof event.xp === "number" ? { xp: event.xp } : {}),
            ...(sanitizeMeta(event.meta) ? { meta: sanitizeMeta(event.meta) } : {}),
            at: event.at,
          })
        } catch (err) {
          recordSilentFailure(
            pluginId,
            { site: "pet.onEvent", message: "pet event subscriber threw", expected: true },
            err
          )
        }
      }),
    getRemainingBudget: () => remainingPetAllowance({ kind: "plugin", id: pluginId }),
    interact: async (kind, opts) =>
      unwrap(
        await requestPetInteraction(
          { kind: "plugin", id: pluginId },
          kind,
          opts?.itemId ? { itemId: opts.itemId } : {}
        )
      ),
    emitEvent: async (kind, opts) =>
      unwrap(
        await requestPetReward({ kind: "plugin", id: pluginId }, kind, {
          xp: opts?.xp,
          coins: opts?.coins,
          meta: sanitizeMeta(opts?.meta),
        })
      ),
  }

  return createGuardedAPI(pluginId, api, PET_API_PERMISSIONS)
}

function noopPetAPI(pluginId: string): PluginPetAPI {
  const warnOnce = createWarnOnce(pluginId)
  return {
    getView: async () => {
      warnOnce()
      return null
    },
    getSummary: async () => {
      warnOnce()
      return null
    },
    getAvailability: async () => {
      warnOnce()
      return { available: false, reason: "missing-capability" }
    },
    onEvent: () => {
      warnOnce()
      return () => {}
    },
    getRemainingBudget: () => {
      warnOnce()
      return { xp: 0, coins: 0 }
    },
    interact: async () => {
      warnOnce()
      return { grantedXp: 0, grantedCoins: 0 }
    },
    emitEvent: async () => {
      warnOnce()
      return { grantedXp: 0, grantedCoins: 0 }
    },
  }
}

function createWarnOnce(pluginId: string): () => void {
  let warned = false
  return () => {
    if (warned) return
    warned = true
    loggers.plugin.warn(
      "plugin tried to use ctx.pet without the 'pet' capability — declare it in plugin.json",
      { pluginId }
    )
    recordSilentFailure(
      pluginId,
      {
        site: "pet.capability",
        message: "ctx.pet used without the 'pet' capability",
        expected: true,
      },
      new Error("missing 'pet' capability")
    )
  }
}

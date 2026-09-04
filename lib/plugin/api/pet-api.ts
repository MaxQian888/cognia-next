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
import type { PetEventKind, PetEventSource } from "@/types/pet"
import { getPetProfile } from "@/lib/db/pet"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { projectPetSummary, type PetSummary } from "@/lib/pet/access/summary"
import {
  MAX_XP_PER_REWARD,
  PET_REWARDABLE_KINDS,
  remainingPetAllowance,
  requestPetInteraction,
  requestPetReward,
  type PetAccessResult,
  type PetInteractionKind,
} from "@/lib/pet/access/gate"

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

/** Kinds a plugin may emit through `emitEvent`, nurture and neutral only. */
export const PLUGIN_EMITTABLE_PET_EVENT_KINDS: readonly PetEventKind[] = PET_REWARDABLE_KINDS

/** Hard per-call XP ceiling, below the daily budget. */
export const MAX_XP_PER_EMIT = MAX_XP_PER_REWARD

/** Sanitized event forwarded to plugin subscribers. */
export interface PluginPetEvent {
  source: PetEventSource
  kind: PetEventKind
  xp?: number
  /** Reduced meta — id-shaped keys only; free-form text never crosses. */
  meta?: {
    achievementId?: string
    itemId?: string
    goalId?: string
    level?: number
    stage?: string
  }
  at: number
}

export class PetEventKindNotAllowedError extends Error {
  constructor(kind: string) {
    super(
      `Pet event kind "${kind}" is not plugin-emittable. Allowed: ${PLUGIN_EMITTABLE_PET_EVENT_KINDS.join(", ")}`
    )
    this.name = "PetEventKindNotAllowedError"
  }
}

/**
 * Thrown when a plugin names an item it does not own (or one that is not a
 * consumable). `applyPetEvent` applies the named item's stronger `needsEffect`
 * in place of the base restore, so before the access gate an unowned id was a
 * free upgrade: the shop path checked ownership and decremented stock, this
 * path did neither.
 */
export class PetItemNotOwnedError extends Error {
  constructor(itemId: string) {
    super(`Pet item "${itemId}" is not owned, or is not a consumable.`)
    this.name = "PetItemNotOwnedError"
  }
}

export interface PluginPetAPI {
  /** Live public view of the pet (null before the profile is initialized). */
  getView(): Promise<PluginPetSummary | null>
  /** Alias of getView — kept separate so a richer projection can grow later. */
  getSummary(): Promise<PluginPetSummary | null>
  /** Subscribe to sanitized pet events. Returns a disposer. */
  onEvent(cb: (event: PluginPetEvent) => void): () => void
  /** Remaining daily reward budget for THIS plugin (for quest UIs). */
  getRemainingBudget(): { xp: number; coins: number }
  /**
   * Emit a direct nurture interaction (rate-limited). The kind's host award
   * amounts are spent from the SAME daily budget as `emitEvent`. At zero
   * remaining budget the interaction still settles needs/mood and plays its
   * flourish, it just grants nothing. Returns what was actually granted.
   */
  interact(
    kind: PluginPetInteractionKind,
    opts?: { itemId?: string }
  ): Promise<{ grantedXp: number; grantedCoins: number }>
  /**
   * Emit a whitelisted event with an optional XP/coin reward, clamped per
   * call and against the daily budget. Returns what was actually granted.
   */
  emitEvent(
    kind: PetEventKind,
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
    case "rate-limited":
      throw refusal.cause instanceof Error ? refusal.cause : new Error("Pet rate limit exceeded")
    case "unavailable":
      return { grantedXp: 0, grantedCoins: 0 }
  }
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

  return createGuardedAPI(pluginId, api, {
    getView: "pet:read",
    getSummary: "pet:read",
    onEvent: "pet:read",
    getRemainingBudget: "pet:read",
    interact: "pet:interact",
    emitEvent: "pet:interact",
  })
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

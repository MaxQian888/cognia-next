// Plugin-facing desktop-pet API (ctx.pet). Gated twice:
//
//   1. Capability gate — without the `"pet"` capability every method is a
//      warn-once no-op (tray-api pattern), so ctx.pet never throws for
//      plugins that simply didn't opt in.
//   2. Permission guard — reads need `pet:read`, interactions/rewards need
//      `pet:interact` (fail-closed `createGuardedAPI` proxy).
//
// Anti-abuse (the API is open to third-party plugins):
//   - token-bucket rate limits per plugin ("pet:interact" / "pet:emit")
//   - a daily XP/coin budget per plugin (lib/plugin/api/pet-budget.ts) —
//     rewards are CLAMPED to the remainder, and the granted amounts ride the
//     event as explicit overrides so the award tables can't be farmed
//   - an emittable-kind whitelist: nurture/neutral kinds only, lifecycle
//     kinds (hatched/levelUp/evolved/achievementUnlocked/unwell) throw
//
// PII red-line: the summary never exposes accountFingerprint/bones/soul
// internals, and forwarded events carry a REDUCED meta (id-shaped keys only —
// `talked` events' meta.userText never crosses into plugin code).

import { loggers } from "@/lib/logging"
import type { PluginCapability } from "@/types/plugin/plugin"
import type {
  PetCondition,
  PetEventKind,
  PetEventSource,
  PetMood,
  PetNeeds,
  PetStage,
} from "@/types/pet"
import { getPetProfile } from "@/lib/db/pet"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { emitPetEvent, getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { getPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { consumePetBudget, getRemainingPetBudget } from "./pet-budget"

/** PII-safe projection of the pet's public state. */
export interface PluginPetSummary {
  hatched: boolean
  name: string | null
  level: number
  stage: PetStage
  xp: number
  mood: PetMood
  needs: Pick<PetNeeds, "energy" | "mood" | "bond">
  condition: PetCondition
  coins: number
}

/** Direct nurture interactions a plugin may perform. */
export type PluginPetInteractionKind =
  | "fed"
  | "played"
  | "petted"
  | "talked"
  | "slept"
  | "cleaned"
  | "treated"

const INTERACTION_KINDS: ReadonlySet<string> = new Set<PluginPetInteractionKind>([
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
])

/** Kinds a plugin may emit through `emitEvent` — nurture/neutral only. */
export const PLUGIN_EMITTABLE_PET_EVENT_KINDS: readonly PetEventKind[] = [
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
export const MAX_XP_PER_EMIT = 10

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

export interface PluginPetAPI {
  /** Live public view of the pet (null before the profile is initialized). */
  getView(): Promise<PluginPetSummary | null>
  /** Alias of getView — kept separate so a richer projection can grow later. */
  getSummary(): Promise<PluginPetSummary | null>
  /** Subscribe to sanitized pet events. Returns a disposer. */
  onEvent(cb: (event: PluginPetEvent) => void): () => void
  /** Remaining daily reward budget for THIS plugin (for quest UIs). */
  getRemainingBudget(): { xp: number; coins: number }
  /** Emit a direct nurture interaction (rate-limited). */
  interact(kind: PluginPetInteractionKind, opts?: { itemId?: string }): Promise<void>
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

function projectSummary(
  profile: NonNullable<Awaited<ReturnType<typeof getPetProfile>>>,
  now: number
): PluginPetSummary {
  const view = computePetView(profile, null, now)
  return {
    hatched: profile.soul !== null,
    name: profile.soul?.name ?? null,
    level: profile.level,
    stage: profile.stage,
    xp: profile.xp,
    mood: view.mood,
    needs: {
      energy: view.needs.energy,
      mood: view.needs.mood,
      bond: view.needs.bond,
    },
    condition: view.condition,
    coins:
      typeof profile.coins === "number" && Number.isFinite(profile.coins)
        ? Math.max(0, Math.floor(profile.coins))
        : 0,
  }
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

export function createPetAPI({ pluginId, capabilities }: CreatePetAPIArgs): PluginPetAPI {
  if (!capabilities.includes("pet")) return noopPetAPI(pluginId)

  const api: PluginPetAPI = {
    getView: async () => {
      const profile = await getPetProfile()
      return profile ? projectSummary(profile, Date.now()) : null
    },
    getSummary: async () => {
      const profile = await getPetProfile()
      return profile ? projectSummary(profile, Date.now()) : null
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
    getRemainingBudget: () => getRemainingPetBudget(pluginId),
    interact: async (kind, opts) => {
      if (!INTERACTION_KINDS.has(kind)) throw new PetEventKindNotAllowedError(kind)
      getPluginRateLimiter().check(pluginId, "pet:interact")
      emitPetEvent({
        source: "plugin",
        kind,
        meta: { pluginId, ...(opts?.itemId ? { itemId: opts.itemId } : {}) },
      })
    },
    emitEvent: async (kind, opts) => {
      if (!PLUGIN_EMITTABLE_PET_EVENT_KINDS.includes(kind)) {
        throw new PetEventKindNotAllowedError(kind)
      }
      getPluginRateLimiter().check(pluginId, "pet:emit")
      const askXp = Math.min(MAX_XP_PER_EMIT, Math.max(0, Math.floor(opts?.xp ?? 0)))
      const { grantedXp, grantedCoins } = consumePetBudget(pluginId, {
        xp: askXp,
        coins: opts?.coins,
      })
      // Explicit xp/coins overrides ALWAYS ride the event (even 0) so a
      // plugin emission can never fall through to the host award tables.
      emitPetEvent({
        source: "plugin",
        kind,
        xp: grantedXp,
        meta: { ...sanitizeMeta(opts?.meta), pluginId, coins: grantedCoins },
      })
      return { grantedXp, grantedCoins }
    },
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

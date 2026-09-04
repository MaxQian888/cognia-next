/**
 * The agent's half of the desktop pet.
 *
 * Plugins have had a full guarded `ctx.pet` for a long time: read the PII-safe
 * summary, subscribe to sanitized events, nurture, and grant clamped rewards.
 * The agent, which is the thing the user actually talks to, had nothing. The
 * pet observed the agent through sixteen one-way event-source adapters and
 * nothing ever flowed back, so the agent could not answer "how is my pet?",
 * could not react to it, and could not put it on screen.
 *
 * ## Why this rides the plugin-tool relay
 *
 * The built-in-skill tier is the wrong shape three times over. Its surfacing
 * switch (`character.enableBuiltInSkills`) turns Lark, IM, issues, scheduler
 * and the pet on together, so "pet yes, Lark no" is inexpressible. Its write
 * tier puts a HITL approval dialog in front of every mutation, which would
 * mean a modal to feed a pet, and its registry refuses to register a write
 * skill that ships no A2UI confirm card. And `BuiltInSkill.platforms` is an IM
 * platform axis, while the pet's real constraints are the host (desktop and
 * web only, ADR-0059) and the window role.
 *
 * The relay already expresses exactly those: `build-options.ts` drops Canvas
 * on native mobile and gates Sites on `isTauri()`. The pet's state also lives
 * in the renderer (Dexie plus a zustand store), which the sidecar cannot
 * import, and that is precisely what this channel exists for.
 *
 * ## Import discipline
 *
 * Static imports here are TYPE-ONLY. `plugin-tool-ipc` is imported by the Node
 * CLI, which has no DOM, so every real dependency is reached through
 * `await import()` at call time.
 */

import type { PetConsoleTab } from "@/lib/pet/console-tabs"
import type { PetOneShot } from "@/types/pet"

export const PET_BUILTIN_PLUGIN_ID = "cognia-pet-builtin"

export const PET_STATUS_TOOL_NAME = "pet_status"
export const PET_CARE_TOOL_NAME = "pet_care"
export const PET_SAY_TOOL_NAME = "pet_say"
export const PET_REWARD_TOOL_NAME = "pet_reward"
export const PET_SHOW_TOOL_NAME = "pet_show"

export const PET_TOOL_NAMES = [
  PET_STATUS_TOOL_NAME,
  PET_CARE_TOOL_NAME,
  PET_SAY_TOOL_NAME,
  PET_REWARD_TOOL_NAME,
  PET_SHOW_TOOL_NAME,
] as const

const PET_TOOL_NAME_SET: ReadonlySet<string> = new Set(PET_TOOL_NAMES)

export function isPetBuiltinTool(name: string): boolean {
  return PET_TOOL_NAME_SET.has(name)
}

export interface PetManifestEntry {
  name: string
  pluginId: string
  description: string
  jsonSchema: Record<string, unknown>
}

/** Nurture actions, in the agent's vocabulary, mapped to the event kinds. */
const CARE_ACTIONS = {
  feed: "fed",
  play: "played",
  pet: "petted",
  sleep: "slept",
  clean: "cleaned",
  treat: "treated",
} as const
type CareAction = keyof typeof CARE_ACTIONS

/** Milestone kinds the agent may reward, a strict subset of the plugin set. */
const REWARD_KINDS = ["goalComplete", "teamRun", "workflowRun", "success", "review"] as const

const EMOTIONS: readonly PetOneShot[] = ["happy", "sad", "surprised", "love", "sleepy", "wave"]

const CONSOLE_TABS: readonly PetConsoleTab[] = [
  "nurture",
  "chat",
  "shop",
  "customize",
  "insights",
  "journal",
  "dex",
  "achievements",
  "binding",
  "plugins",
]

const MAX_SAY_CHARS = 200

export function buildPetManifestEntries(): PetManifestEntry[] {
  return [
    {
      name: PET_STATUS_TOOL_NAME,
      pluginId: PET_BUILTIN_PLUGIN_ID,
      description:
        "Read the user's desktop pet: name, level, stage, mood, needs, condition, coins and streak. Use it when the user asks about their pet, or before nurturing so you know what it actually needs. An unhatched egg is a successful read with `hatched: false`.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          include: {
            type: "array",
            items: { type: "string", enum: ["activity", "achievements", "inventory"] },
            description: "Extra sections to fetch. Omit for the base summary.",
          },
        },
      },
    },
    {
      name: PET_CARE_TOOL_NAME,
      pluginId: PET_BUILTIN_PLUGIN_ID,
      description:
        "Nurture the pet. Each action is on a short cooldown and refuses while it is cooling, so read `pet_status` first rather than retrying. Talking is not here: use `pet_say`.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: Object.keys(CARE_ACTIONS) },
          itemId: {
            type: "string",
            maxLength: 80,
            description:
              "Use an owned consumable from the pet's inventory for a stronger effect. Refused when the pet does not own it.",
          },
        },
      },
    },
    {
      name: PET_SAY_TOOL_NAME,
      pluginId: PET_BUILTIN_PLUGIN_ID,
      description:
        "Make the pet say something in its speech bubble, in the pet's voice rather than yours. Good for reacting to what just happened. Shares the user's own speak budget, so it will refuse if the pet has been talking a lot.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_SAY_CHARS },
          emotion: { type: "string", enum: [...EMOTIONS] },
          durationMs: { type: "integer", minimum: 1000, maximum: 15000 },
        },
      },
    },
    {
      name: PET_REWARD_TOOL_NAME,
      pluginId: PET_BUILTIN_PLUGIN_ID,
      description:
        "Give the pet XP and coins for a milestone the user reached. Amounts are clamped per call and against a daily budget, so an exhausted budget is a success that granted zero, not an error.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: [...REWARD_KINDS] },
          xp: { type: "integer", minimum: 0, maximum: 10 },
          coins: { type: "integer", minimum: 0, maximum: 25 },
        },
      },
    },
    {
      name: PET_SHOW_TOOL_NAME,
      pluginId: PET_BUILTIN_PLUGIN_ID,
      description:
        "Bring the pet to the user's attention: raise the desktop overlay, or open the pet console on a tab. Ask the user before using this unprompted, since the overlay floats above whatever they are doing.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", enum: ["overlay", "console"] },
          tab: { type: "string", enum: [...CONSOLE_TABS] },
        },
      },
    },
  ]
}

export type PetToolFailureCode =
  | "invalid_arguments"
  | "pet_disabled"
  | "pet_unavailable_here"
  | "pet_uninitialized"
  | "pet_unhatched"
  | "cooldown"
  | "rate_limited"
  | "item_not_owned"
  | "bubbles_muted"
  | "pii_blocked"
  | "overlay_unavailable"

interface Failure {
  ok: false
  code: PetToolFailureCode
  error: string
}

function fail(code: PetToolFailureCode, error: string): Failure {
  return { ok: false, code, error }
}

export interface PetToolContext {
  sessionId?: string
}

export interface PetToolDeps {
  getProfile: () => Promise<import("@/types/pet").PetProfile | undefined>
  summarize: (profile: import("@/types/pet").PetProfile, now: number) => unknown
  interact: (
    kind: string,
    opts: { itemId?: string }
  ) => Promise<import("@/lib/pet/access/gate").PetAccessResult>
  reward: (
    kind: string,
    opts: { xp?: number; coins?: number }
  ) => Promise<import("@/lib/pet/access/gate").PetAccessResult>
  say: (
    text: string,
    opts: { emotion?: PetOneShot; durationMs?: number }
  ) => import("@/lib/pet/bubbles/say").SayResult
  openOverlay: () => Promise<boolean>
  openConsole: (tab?: PetConsoleTab) => boolean
  listActivity: (limit: number) => Promise<unknown[]>
  listAchievements: () => Promise<unknown[]>
  listInventory: () => Promise<unknown[]>
  bubblesMuted: () => boolean
  now: () => number
}

let testDepsFactory: (() => PetToolDeps) | null = null

/**
 * Test seam, mirroring `__setVectorToolDepsForTesting`. The routing suite needs
 * to prove the relay reaches this family ahead of the plugin registry without
 * standing up Dexie, a settings store and a window.
 */
export function __setPetToolDepsForTesting(factory: (() => PetToolDeps) | null): void {
  testDepsFactory = factory
}

/**
 * Resolve the real dependencies. Everything is reached through `await import()`
 * so this module stays importable from the Node CLI, which has no DOM.
 */
export async function resolvePetToolDeps(): Promise<PetToolDeps> {
  if (testDepsFactory) return testDepsFactory()
  const [db, summary, gate, say, commands, consoleRequest, settings] = await Promise.all([
    import("@/lib/db/pet"),
    import("@/lib/pet/access/summary"),
    import("@/lib/pet/access/gate"),
    import("@/lib/pet/bubbles/say"),
    import("@/lib/pet/commands"),
    import("@/lib/pet/console-request"),
    import("@/stores/settings"),
  ])
  const subject = { kind: "agent" } as const
  return {
    getProfile: () => db.getPetProfile(),
    summarize: (profile, now) => summary.projectPetSummary(profile, now),
    interact: (kind, opts) => gate.requestPetInteraction(subject, kind, opts),
    reward: (kind, opts) =>
      gate.requestPetReward(subject, kind as import("@/types/pet").PetEventKind, opts),
    say: (text, opts) => say.sayAsPet(text, { ...opts, origin: "llm" }),
    openOverlay: () => commands.openDesktopPetWindow(),
    openConsole: (tab) => consoleRequest.requestPetConsole(tab ? { tab } : {}),
    listActivity: (limit) => db.listPetActivity(limit),
    listAchievements: () => db.listPetAchievements(),
    listInventory: () => db.listPetInventory(),
    bubblesMuted: () =>
      settings.useSettingsStore.getState().settings?.petSettings?.mutedBubbles === true,
    now: () => Date.now(),
  }
}

/** Map an access-gate refusal onto the tool failure vocabulary. */
function refusalToFailure(refusal: import("@/lib/pet/access/gate").PetRefusal): Failure {
  switch (refusal.code) {
    case "unavailable":
      return refusal.reason === "disabled"
        ? fail("pet_disabled", "The desktop pet is switched off in Settings.")
        : fail(
            "pet_unavailable_here",
            "The pet does not run on this surface (mobile, or a secondary window)."
          )
    case "rate-limited":
      return fail("rate_limited", "Too many pet actions in a row. Wait a moment.")
    case "kind-not-allowed":
      return fail("invalid_arguments", `"${refusal.kind}" is not an allowed pet action.`)
    case "unknown-item":
    case "item-not-owned":
      return fail("item_not_owned", `The pet does not own the item "${refusal.itemId}".`)
  }
}

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
}

/**
 * Run one pet tool. Never throws: every failure collapses onto the `ok: false`
 * envelope, because the relay hands an `ok: false` payload to the model as a
 * successful tool result, and a refusal is something the model should adapt to
 * rather than an aborted step.
 */
export async function runPetBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: PetToolDeps,
  _context: PetToolContext = {}
): Promise<unknown> {
  try {
    switch (name) {
      case PET_STATUS_TOOL_NAME: {
        const profile = await deps.getProfile()
        if (!profile) {
          return fail("pet_uninitialized", "The pet has not been set up on this device yet.")
        }
        const include = Array.isArray(args.include) ? args.include.map(String) : []
        const out: Record<string, unknown> = {
          ok: true,
          ...(deps.summarize(profile, deps.now()) as Record<string, unknown>),
          streakDays: profile.streak?.days ?? 0,
        }
        if (include.includes("activity")) out.activity = await deps.listActivity(20)
        if (include.includes("achievements")) out.achievements = await deps.listAchievements()
        if (include.includes("inventory")) out.inventory = await deps.listInventory()
        return out
      }

      case PET_CARE_TOOL_NAME: {
        const action = str(args, "action") as CareAction | null
        if (!action || !(action in CARE_ACTIONS)) {
          return fail(
            "invalid_arguments",
            `action must be one of ${Object.keys(CARE_ACTIONS).join(", ")}`
          )
        }
        const profile = await deps.getProfile()
        if (!profile) {
          return fail("pet_uninitialized", "The pet has not been set up on this device yet.")
        }
        if (!profile.soul) {
          return fail(
            "pet_unhatched",
            "The pet is still an egg. It has to hatch in the pet console before it can be nurtured."
          )
        }
        const itemId = str(args, "itemId")
        const result = await deps.interact(CARE_ACTIONS[action], itemId ? { itemId } : {})
        if (!result.ok) return refusalToFailure(result.refusal)

        const after = await deps.getProfile()
        return {
          ok: true,
          action,
          kind: CARE_ACTIONS[action],
          grantedXp: result.grantedXp,
          grantedCoins: result.grantedCoins,
          ...(after ? (deps.summarize(after, deps.now()) as Record<string, unknown>) : {}),
        }
      }

      case PET_SAY_TOOL_NAME: {
        const text = str(args, "text")
        if (!text) return fail("invalid_arguments", "text is required")
        if (text.length > MAX_SAY_CHARS) {
          return fail("invalid_arguments", `text must be ${MAX_SAY_CHARS} characters or fewer`)
        }
        const profile = await deps.getProfile()
        if (!profile?.soul) {
          return fail("pet_unhatched", "The pet has not hatched yet, so it has no voice.")
        }
        if (deps.bubblesMuted()) {
          return fail("bubbles_muted", "The user has muted the pet's speech bubbles.")
        }
        const emotionRaw = str(args, "emotion")
        const emotion = EMOTIONS.includes(emotionRaw as PetOneShot)
          ? (emotionRaw as PetOneShot)
          : undefined
        const said = deps.say(text, { emotion, durationMs: int(args, "durationMs") })
        if (!said.ok) {
          if (said.reason === "pii") {
            return fail("pii_blocked", "That line looked like it contained personal data.")
          }
          if (said.reason === "muted") {
            return fail("bubbles_muted", "The user has muted the pet's speech bubbles.")
          }
          if (said.reason === "rate-limited") {
            return fail("rate_limited", "The pet has been talking a lot. Give it a moment.")
          }
          return fail("invalid_arguments", "There was nothing left to say after trimming.")
        }
        return { ok: true, text: said.text, clearsAt: said.clearsAt }
      }

      case PET_REWARD_TOOL_NAME: {
        const kind = str(args, "kind")
        if (!kind || !REWARD_KINDS.includes(kind as (typeof REWARD_KINDS)[number])) {
          return fail("invalid_arguments", `kind must be one of ${REWARD_KINDS.join(", ")}`)
        }
        const result = await deps.reward(kind, {
          xp: int(args, "xp"),
          coins: int(args, "coins"),
        })
        if (!result.ok) return refusalToFailure(result.refusal)
        return {
          ok: true,
          kind,
          grantedXp: result.grantedXp,
          grantedCoins: result.grantedCoins,
        }
      }

      case PET_SHOW_TOOL_NAME: {
        const target = str(args, "target") ?? "console"
        const tabRaw = str(args, "tab")
        const tab = CONSOLE_TABS.includes(tabRaw as PetConsoleTab)
          ? (tabRaw as PetConsoleTab)
          : undefined
        if (target === "overlay") {
          const opened = await deps.openOverlay()
          if (!opened) {
            return fail(
              "overlay_unavailable",
              "The floating desktop pet is only available in the desktop app."
            )
          }
          return { ok: true, target: "overlay", opened: true }
        }
        const opened = deps.openConsole(tab)
        if (!opened) {
          return fail("pet_unavailable_here", "There is no shell here to open the console in.")
        }
        return { ok: true, target: "console", opened: true, ...(tab ? { tab } : {}) }
      }

      default:
        return fail("invalid_arguments", `Unknown pet tool "${name}"`)
    }
  } catch (err) {
    return fail("invalid_arguments", err instanceof Error ? err.message : String(err))
  }
}

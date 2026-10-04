// Shape validation for the two data-only pet contributions a plugin manifest
// can declare (`petItems[]`, `petAchievements[]`).
//
// One validator, three callers: manifest validation (an invalid entry is a
// manifest error), the overlay registration (`capability-bridge-map.ts` throws,
// and the dispatch loop drops only that entry — the guard for manifests stored
// before this check existed), and the SDK `definePetItem` /
// `definePetAchievement` helpers (so an author sees the same rule at build
// time). Before this, nothing checked the shapes at registration: an
// achievement whose condition the compiler did not recognize hit
// `default: return false` and silently never unlocked, and a counter on a kind
// the activity ledger never records could not unlock either.
//
// Pure and dependency-free (the SDK bundles it). Icon names are not checked
// here: manifest validation already resolves them against lucide-react.

import { PET_EVENT_KINDS } from "@/types/pet/events"
import { PET_INTERACTION_KINDS } from "@/lib/pet/access/limits"
import type { PluginPetAchievementDef, PluginPetItemDef } from "@/types/plugin/plugin-pet"

/** One problem with a contribution, addressed relative to the entry. */
export interface PetContributionIssue {
  /** Path inside the entry, e.g. `price` or `condition.kind`. */
  path: string
  message: string
}

/** Pack-local ids: they become `plugin:<pluginId>:<id>` and unlock-record keys. */
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const ITEM_CATEGORIES = new Set(["food", "toy", "decor"])
const NEEDS = new Set(["energy", "mood", "bond"])
const INTERACTION_KIND_SET: ReadonlySet<string> = new Set(PET_INTERACTION_KINDS)
const EVENT_KIND_SET: ReadonlySet<string> = new Set(PET_EVENT_KINDS)

/** Upper bound of one need restore (needs are 0–100). */
const MAX_NEED_EFFECT = 100

/** Prices above this cannot be earned in any reasonable time; refuse them. */
export const MAX_PET_ITEM_PRICE = 100_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkId(id: unknown, issues: PetContributionIssue[]): void {
  if (typeof id !== "string" || !LOCAL_ID.test(id)) {
    issues.push({
      path: "id",
      message:
        "must be 1–64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit",
    })
  }
}

function checkLabels(
  labels: unknown,
  field: "labels" | "descriptions",
  required: boolean,
  issues: PetContributionIssue[]
): void {
  if (labels === undefined && !required) return
  if (!isRecord(labels)) {
    issues.push({ path: field, message: "must be an object keyed by locale" })
    return
  }
  for (const [locale, text] of Object.entries(labels)) {
    if (typeof text !== "string") {
      issues.push({ path: `${field}.${locale}`, message: "must be a string" })
    }
  }
  if (required && (typeof labels.en !== "string" || labels.en.trim().length === 0)) {
    issues.push({ path: `${field}.en`, message: "must be a non-empty English label" })
  }
}

function checkIcon(icon: unknown, issues: PetContributionIssue[]): void {
  if (icon !== undefined && (typeof icon !== "string" || icon.trim().length === 0)) {
    issues.push({ path: "icon", message: "must be a lucide-react icon name" })
  }
}

/** Every problem with a `petItems[]` entry; empty when it is valid. */
export function validatePetItemDef(def: unknown): PetContributionIssue[] {
  const issues: PetContributionIssue[] = []
  if (!isRecord(def)) return [{ path: "", message: "must be an object" }]
  checkId(def.id, issues)
  checkLabels(def.labels, "labels", true, issues)
  checkLabels(def.descriptions, "descriptions", false, issues)
  checkIcon(def.icon, issues)
  if (typeof def.category !== "string" || !ITEM_CATEGORIES.has(def.category)) {
    issues.push({ path: "category", message: 'must be "food", "toy" or "decor"' })
  }
  if (
    typeof def.price !== "number" ||
    !Number.isInteger(def.price) ||
    def.price <= 0 ||
    def.price > MAX_PET_ITEM_PRICE
  ) {
    issues.push({
      path: "price",
      message: `must be a whole number of coins from 1 to ${MAX_PET_ITEM_PRICE}`,
    })
  }
  if (typeof def.consumable !== "boolean") {
    issues.push({ path: "consumable", message: "must be true or false" })
  }
  if (def.interactionKind !== undefined) {
    if (typeof def.interactionKind !== "string" || !INTERACTION_KIND_SET.has(def.interactionKind)) {
      issues.push({
        path: "interactionKind",
        message: `must be one of ${PET_INTERACTION_KINDS.join(", ")}`,
      })
    }
  } else if (def.consumable === true) {
    // A consumable is USED, and using it is an interaction; without a kind
    // the inventory has nothing to emit and the item can only be hoarded.
    issues.push({ path: "interactionKind", message: "is required for a consumable item" })
  }
  if (def.needsEffect !== undefined) {
    if (!isRecord(def.needsEffect)) {
      issues.push({ path: "needsEffect", message: "must be an object of need → amount" })
    } else {
      for (const [need, amount] of Object.entries(def.needsEffect)) {
        if (!NEEDS.has(need)) {
          issues.push({
            path: `needsEffect.${need}`,
            message: 'is not a need (use "energy", "mood" or "bond")',
          })
        } else if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          Math.abs(amount) > MAX_NEED_EFFECT
        ) {
          issues.push({
            path: `needsEffect.${need}`,
            message: `must be a number from -${MAX_NEED_EFFECT} to ${MAX_NEED_EFFECT}`,
          })
        }
      }
      if (def.consumable !== true) {
        issues.push({
          path: "needsEffect",
          message: "only applies to a consumable item (it is applied when the item is used)",
        })
      }
    }
  }
  return issues
}

/** Every problem with a `petAchievements[]` entry; empty when it is valid. */
export function validatePetAchievementDef(def: unknown): PetContributionIssue[] {
  const issues: PetContributionIssue[] = []
  if (!isRecord(def)) return [{ path: "", message: "must be an object" }]
  checkId(def.id, issues)
  checkLabels(def.labels, "labels", true, issues)
  checkLabels(def.descriptions, "descriptions", false, issues)
  checkIcon(def.icon, issues)
  const condition = def.condition
  if (!isRecord(condition)) {
    issues.push({ path: "condition", message: "must be an object" })
    return issues
  }
  if (typeof condition.gte !== "number" || !Number.isFinite(condition.gte) || condition.gte < 0) {
    issues.push({ path: "condition.gte", message: "must be a finite non-negative number" })
  }
  switch (condition.type) {
    case "counter":
      if (typeof condition.kind !== "string" || !EVENT_KIND_SET.has(condition.kind)) {
        issues.push({
          path: "condition.kind",
          message:
            "must be a pet event kind the activity ledger records (e.g. fed, goalComplete, pluginReward)",
        })
      }
      break
    case "level":
      break
    case "need":
      if (typeof condition.need !== "string" || !NEEDS.has(condition.need)) {
        issues.push({ path: "condition.need", message: 'must be "energy", "mood" or "bond"' })
      } else if (typeof condition.gte === "number" && condition.gte > 100) {
        issues.push({ path: "condition.gte", message: "a need never exceeds 100" })
      }
      break
    default:
      issues.push({ path: "condition.type", message: 'must be "counter", "level" or "need"' })
  }
  return issues
}

/** One-line summary for an error message. */
export function formatPetContributionIssues(
  context: string,
  issues: readonly PetContributionIssue[]
): string {
  return `${context}: ${issues
    .map((issue) => (issue.path ? `${issue.path} ${issue.message}` : issue.message))
    .join("; ")}`
}

/** Throw when an item is invalid; returns it typed when it is not. */
export function assertValidPetItemDef(def: unknown, context: string): PluginPetItemDef {
  const issues = validatePetItemDef(def)
  if (issues.length > 0) throw new Error(formatPetContributionIssues(context, issues))
  return def as PluginPetItemDef
}

/** Throw when an achievement is invalid; returns it typed when it is not. */
export function assertValidPetAchievementDef(
  def: unknown,
  context: string
): PluginPetAchievementDef {
  const issues = validatePetAchievementDef(def)
  if (issues.length > 0) throw new Error(formatPetContributionIssues(context, issues))
  return def as PluginPetAchievementDef
}

// Where a refused or failed pet action turns into words.
//
// The access gate and the shop answer with codes (`PetRefusal`,
// `PurchaseError`, `ConsumeError`) and stay i18n-free, the way the controller
// does. Every console surface that toasts an outcome resolves the code here, so
// the shop, the inventory strip and a later remote-care path cannot each grow
// their own wording for the same refusal. Keys are relative to the `pet`
// namespace; both locales author every key listed below.

import type { PetRefusal } from "@/lib/pet/access/gate"
import type { ConsumeResult, PurchaseError } from "@/lib/pet/economy/shop"
import type { PetRemoteRefusal } from "@/lib/pet/remote/types"

export interface PetOutcomeMessage {
  key: string
  values?: Record<string, string | number>
}

/** Every `outcomes.refusal.*` key a refusal can resolve to. */
export const PET_REFUSAL_MESSAGE_KEYS = [
  "outcomes.refusal.unavailable",
  "outcomes.refusal.rateLimited",
  "outcomes.refusal.kindNotAllowed",
  "outcomes.refusal.unknownItem",
  "outcomes.refusal.itemNotOwned",
  "outcomes.refusal.itemKindMismatch",
  "outcomes.refusal.uninitialized",
  "outcomes.refusal.notHatched",
  "outcomes.refusal.coolingDown",
] as const

/**
 * Why a console action did not happen, for callers that branch on it (the
 * remote console refreshes its snapshot after a refusal but not after the
 * desktop could not be reached).
 */
export type PetActionFailure =
  /** The pet (or the host's gate) said no; `message` says why. */
  | "refused"
  /** The paired desktop did not answer. */
  | "unreachable"
  /** This console mode cannot do it at all (see `action-capabilities.ts`). */
  | "desktop-only"
  /** A write threw or answered something unusable. */
  | "failed"

/**
 * What every console action resolves to. Actions never throw: a refusal, a
 * lost connection and a thrown write all become a value the caller can show.
 * `pending` marks work the desktop accepted but had not finished inside the
 * bridge window (a hatch, a chat reply); its result arrives through the mirror.
 */
export type PetActionOutcome =
  | { ok: true; pending?: boolean }
  | { ok: false; reason: PetActionFailure; message: PetOutcomeMessage }

export const PET_ACTION_OK: PetActionOutcome = Object.freeze({ ok: true })

export function petActionFailed(
  reason: PetActionFailure,
  message: PetOutcomeMessage
): PetActionOutcome {
  return { ok: false, reason, message }
}

/** Every `outcomes.remote.*` key a remote refusal or failure can resolve to. */
export const PET_REMOTE_MESSAGE_KEYS = [
  "outcomes.remote.headlessHost",
  "outcomes.remote.hostStarting",
  "outcomes.remote.notDecor",
  "outcomes.remote.invalidName",
  "outcomes.remote.disabled",
  "outcomes.remote.unavailable",
  "outcomes.remote.uninitialized",
  "outcomes.remote.unreachable",
  "outcomes.remote.desktopOnly",
] as const

/** Whole seconds, never zero: "wait 0s" reads as "you can now", which it is not. */
function waitSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

export function petRefusalMessage(refusal: PetRefusal): PetOutcomeMessage {
  switch (refusal.code) {
    case "unavailable":
      return { key: "outcomes.refusal.unavailable" }
    case "rate-limited":
      return { key: "outcomes.refusal.rateLimited" }
    case "kind-not-allowed":
      return { key: "outcomes.refusal.kindNotAllowed" }
    case "unknown-item":
      return { key: "outcomes.refusal.unknownItem" }
    case "item-not-owned":
      return { key: "outcomes.refusal.itemNotOwned" }
    case "item-kind-mismatch":
      return { key: "outcomes.refusal.itemKindMismatch" }
    case "uninitialized":
      return { key: "outcomes.refusal.uninitialized" }
    case "not-hatched":
      return { key: "outcomes.refusal.notHatched" }
    case "cooling-down":
      return {
        key: "outcomes.refusal.coolingDown",
        values: { seconds: waitSeconds(refusal.retryAfterMs) },
      }
  }
}

export function purchaseErrorMessage(error: PurchaseError | undefined): PetOutcomeMessage {
  switch (error) {
    case "insufficient-coins":
      return { key: "outcomes.purchase.insufficientCoins" }
    case "unknown-item":
      return petRefusalMessage({ code: "unknown-item", itemId: "" })
    case "no-profile":
      return petRefusalMessage({ code: "uninitialized" })
    default:
      return { key: "outcomes.failed" }
  }
}

export function consumeErrorMessage(result: ConsumeResult): PetOutcomeMessage {
  switch (result.error) {
    case "cooling-down":
      return petRefusalMessage({
        code: "cooling-down",
        kind: "",
        retryAfterMs: result.retryAfterMs ?? 0,
      })
    case "not-hatched":
      return petRefusalMessage({ code: "not-hatched" })
    case "no-profile":
      return petRefusalMessage({ code: "uninitialized" })
    case "not-owned":
      return petRefusalMessage({ code: "item-not-owned", itemId: "" })
    case "unknown-item":
      return petRefusalMessage({ code: "unknown-item", itemId: "" })
    default:
      return { key: "outcomes.failed" }
  }
}

/**
 * A refusal the paired desktop answered a `pet_*` call with.
 *
 * The gate's codes reuse the local wording, except where "here" would point
 * at the wrong device: a pet that is switched off, or not set up yet, is the
 * DESKTOP's state, and the phone says so.
 */
export function petRemoteRefusalMessage(refusal: PetRemoteRefusal): PetOutcomeMessage {
  switch (refusal.code) {
    case "headless-host":
      return { key: "outcomes.remote.headlessHost" }
    case "host-starting":
      return { key: "outcomes.remote.hostStarting" }
    case "insufficient-coins":
      return { key: "outcomes.purchase.insufficientCoins" }
    case "not-decor":
      return { key: "outcomes.remote.notDecor" }
    case "invalid-name":
      return { key: "outcomes.remote.invalidName" }
    case "hatch-failed":
      return { key: "console.hatchFailed" }
    case "unavailable":
      return {
        key:
          refusal.reason === "disabled"
            ? "outcomes.remote.disabled"
            : "outcomes.remote.unavailable",
      }
    case "uninitialized":
      return { key: "outcomes.remote.uninitialized" }
    case "cooling-down":
      return petRefusalMessage({
        code: "cooling-down",
        kind: refusal.kind ?? "",
        retryAfterMs: refusal.retryAfterMs ?? 0,
      })
    case "rate-limited":
      return petRefusalMessage({ code: "rate-limited" })
    case "kind-not-allowed":
      return petRefusalMessage({ code: "kind-not-allowed", kind: refusal.kind ?? "" })
    case "unknown-item":
    case "item-not-owned":
      return petRefusalMessage({ code: refusal.code, itemId: refusal.itemId ?? "" })
    case "item-kind-mismatch":
      return petRefusalMessage({
        code: "item-kind-mismatch",
        itemId: refusal.itemId ?? "",
        kind: refusal.kind ?? "",
      })
    case "not-hatched":
      return petRefusalMessage({ code: "not-hatched" })
  }
}

/** The paired desktop did not answer at all. */
export const PET_REMOTE_UNREACHABLE: PetOutcomeMessage = Object.freeze({
  key: "outcomes.remote.unreachable",
})

/** The action exists only in the desktop app (see `action-capabilities.ts`). */
export const PET_DESKTOP_ONLY: PetOutcomeMessage = Object.freeze({
  key: "outcomes.remote.desktopOnly",
})

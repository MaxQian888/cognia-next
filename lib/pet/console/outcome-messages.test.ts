import en from "@/i18n/messages/en/pet.json"
import zh from "@/i18n/messages/zh-CN/pet.json"
import {
  PET_DESKTOP_ONLY,
  PET_REFUSAL_MESSAGE_KEYS,
  PET_REMOTE_MESSAGE_KEYS,
  PET_REMOTE_UNREACHABLE,
  consumeErrorMessage,
  petActionFailed,
  petRefusalMessage,
  petRemoteRefusalMessage,
  purchaseErrorMessage,
} from "./outcome-messages"

function resolve(root: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined
  }, root)
}

describe("pet outcome messages", () => {
  it("maps every refusal code to an authored key", () => {
    expect(petRefusalMessage({ code: "unavailable", reason: "disabled" })).toEqual({
      key: "outcomes.refusal.unavailable",
    })
    expect(petRefusalMessage({ code: "rate-limited" }).key).toBe("outcomes.refusal.rateLimited")
    expect(petRefusalMessage({ code: "kind-not-allowed", kind: "x" }).key).toBe(
      "outcomes.refusal.kindNotAllowed"
    )
    expect(petRefusalMessage({ code: "item-kind-mismatch", itemId: "x", kind: "fed" }).key).toBe(
      "outcomes.refusal.itemKindMismatch"
    )
    expect(petRefusalMessage({ code: "not-hatched" }).key).toBe("outcomes.refusal.notHatched")
  })

  it("rounds a cooldown up to whole seconds and never says zero", () => {
    expect(petRefusalMessage({ code: "cooling-down", kind: "fed", retryAfterMs: 1400 })).toEqual({
      key: "outcomes.refusal.coolingDown",
      values: { seconds: 2 },
    })
    expect(
      consumeErrorMessage({ ok: false, error: "cooling-down", retryAfterMs: 0 }).values
    ).toEqual({ seconds: 1 })
  })

  it("maps shop errors onto the same wording as the gate", () => {
    expect(purchaseErrorMessage("insufficient-coins").key).toBe(
      "outcomes.purchase.insufficientCoins"
    )
    expect(purchaseErrorMessage("no-profile").key).toBe("outcomes.refusal.uninitialized")
    expect(purchaseErrorMessage("unknown-item").key).toBe("outcomes.refusal.unknownItem")
    expect(consumeErrorMessage({ ok: false, error: "not-owned" }).key).toBe(
      "outcomes.refusal.itemNotOwned"
    )
    expect(consumeErrorMessage({ ok: false, error: "not-hatched" }).key).toBe(
      "outcomes.refusal.notHatched"
    )
    expect(consumeErrorMessage({ ok: false }).key).toBe("outcomes.failed")
  })

  // A paired phone is told about the DESKTOP's pet, so "here" wording that
  // fits the desktop console would point at the wrong device.
  it("words remote refusals for the paired desktop", () => {
    expect(petRemoteRefusalMessage({ code: "headless-host" }).key).toBe(
      "outcomes.remote.headlessHost"
    )
    expect(petRemoteRefusalMessage({ code: "host-starting" }).key).toBe(
      "outcomes.remote.hostStarting"
    )
    expect(petRemoteRefusalMessage({ code: "insufficient-coins" }).key).toBe(
      "outcomes.purchase.insufficientCoins"
    )
    expect(petRemoteRefusalMessage({ code: "not-decor" }).key).toBe("outcomes.remote.notDecor")
    expect(petRemoteRefusalMessage({ code: "invalid-name" }).key).toBe(
      "outcomes.remote.invalidName"
    )
    expect(petRemoteRefusalMessage({ code: "hatch-failed" }).key).toBe("console.hatchFailed")
    expect(petRemoteRefusalMessage({ code: "unavailable", reason: "disabled" }).key).toBe(
      "outcomes.remote.disabled"
    )
    expect(petRemoteRefusalMessage({ code: "unavailable", reason: "secondary-window" }).key).toBe(
      "outcomes.remote.unavailable"
    )
    expect(petRemoteRefusalMessage({ code: "uninitialized" }).key).toBe(
      "outcomes.remote.uninitialized"
    )
  })

  it("keeps the gate's own wording for the refusals that mean the same on any device", () => {
    expect(
      petRemoteRefusalMessage({ code: "cooling-down", kind: "fed", retryAfterMs: 2100 })
    ).toEqual({ key: "outcomes.refusal.coolingDown", values: { seconds: 3 } })
    expect(petRemoteRefusalMessage({ code: "cooling-down" }).values).toEqual({ seconds: 1 })
    expect(petRemoteRefusalMessage({ code: "rate-limited" }).key).toBe(
      "outcomes.refusal.rateLimited"
    )
    expect(petRemoteRefusalMessage({ code: "kind-not-allowed" }).key).toBe(
      "outcomes.refusal.kindNotAllowed"
    )
    expect(petRemoteRefusalMessage({ code: "unknown-item" }).key).toBe(
      "outcomes.refusal.unknownItem"
    )
    expect(petRemoteRefusalMessage({ code: "item-not-owned" }).key).toBe(
      "outcomes.refusal.itemNotOwned"
    )
    expect(petRemoteRefusalMessage({ code: "item-kind-mismatch" }).key).toBe(
      "outcomes.refusal.itemKindMismatch"
    )
    expect(petRemoteRefusalMessage({ code: "not-hatched" }).key).toBe("outcomes.refusal.notHatched")
  })

  it("builds a failed outcome that carries its reason and message", () => {
    expect(petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)).toEqual({
      ok: false,
      reason: "unreachable",
      message: { key: "outcomes.remote.unreachable" },
    })
    expect(PET_DESKTOP_ONLY.key).toBe("outcomes.remote.desktopOnly")
  })

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("has every key authored in %s", (_locale, messages) => {
    for (const key of [
      ...PET_REFUSAL_MESSAGE_KEYS,
      ...PET_REMOTE_MESSAGE_KEYS,
      "outcomes.purchase.insufficientCoins",
      "outcomes.failed",
      "console.hatchFailed",
    ]) {
      expect(typeof resolve(messages, key)).toBe("string")
    }
  })
})

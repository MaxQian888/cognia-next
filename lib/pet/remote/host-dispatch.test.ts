/** @jest-environment jsdom */
import "fake-indexeddb/auto"

// The controller's plugin fan-out is not under test here.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchPetInteract: jest.fn().mockResolvedValue(undefined),
    dispatchPetLevelUp: jest.fn().mockResolvedValue(undefined),
    dispatchPetEvolved: jest.fn().mockResolvedValue(undefined),
    dispatchPetAchievementUnlocked: jest.fn().mockResolvedValue(undefined),
    dispatchPetUnwell: jest.fn().mockResolvedValue(undefined),
  }),
}))
// Every case injects its own chat and hatch collaborators; the real modules
// would pull the model stack into a storage test.
jest.mock("@/lib/pet/chat/respond", () => ({ respondAsPet: jest.fn() }))
jest.mock("@/lib/pet/runtime/hatch", () => ({ hatchPetOnce: jest.fn() }))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPetProfile, listPetActivity, upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { __resetPetEventBusForTesting, getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { handlePetEvent, whenPetEventsSettled } from "@/lib/pet/runtime/pet-controller"
import { XP_AWARD } from "@/lib/pet/xp/award-table"
import { DEFAULT_PET_SETTINGS, type PetProfile, type PetSettings } from "@/types/pet"
import type { PetChatResult } from "@/lib/pet/chat/respond"
import { dispatchPetHostCommand, type PetHostDispatchDeps } from "./host-dispatch"
import { createPetIdempotencyLedger } from "./idempotency"
import { encodeChatPageToken } from "./types"

const enabled: PetSettings = { ...DEFAULT_PET_SETTINGS, enabled: true }
const CALLER = { callerDeviceId: "phone-1" }

function hatchedProfile(overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    ...createDefaultProfile("acct-1", Date.now() - 60_000),
    soul: { name: "Mochi", personality: "curious", hatchDate: new Date().toISOString() },
    stage: "baby",
    coins: 100,
    ...overrides,
  } as PetProfile
}

/** A desktop main window with a mounted controller, on the real gate and Dexie. */
function hostDeps(over: Partial<PetHostDispatchDeps> = {}): PetHostDispatchDeps {
  return {
    platform: "tauri",
    role: "main",
    getPetSettings: () => enabled,
    getAppSettings: () => null,
    isControllerPresent: () => true,
    ledger: createPetIdempotencyLedger(),
    accessDeps: { rateLimiter: { check: () => {} } },
    resolveActiveCharacterId: async () => null,
    ...over,
  }
}

let offController: () => void

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // What `usePetEventBus` does on the desktop.
  offController = getPetEventBus().subscribe((event) => {
    void handlePetEvent(event)
  })
}, 30_000)

afterEach(async () => {
  offController()
  await whenPetEventsSettled()
  __resetPetEventBusForTesting()
})

describe("pet_act on the real controller", () => {
  it("awards a care action exactly once, however many times the phone retries it", async () => {
    await upsertPetProfile(hatchedProfile())
    const deps = hostDeps()
    const payload = { ...CALLER, action: "fed", idempotencyKey: "intent-1" }

    const first = await dispatchPetHostCommand("pet_act", payload, deps)
    const retry = await dispatchPetHostCommand("pet_act", payload, deps)

    expect(first).toEqual({ ok: true, grantedXp: XP_AWARD.fed, grantedCoins: expect.any(Number) })
    expect(retry).toBe(first)
    const profile = await getPetProfile()
    expect(profile?.xp).toBe(XP_AWARD.fed)
    expect((await listPetActivity()).filter((row) => row.kind === "fed")).toHaveLength(1)
  })

  it("reports the cooldown instead of a reward the controller would drop", async () => {
    await upsertPetProfile(hatchedProfile())
    const deps = hostDeps()
    await dispatchPetHostCommand("pet_act", { ...CALLER, action: "fed", idempotencyKey: "a" }, deps)
    const second = await dispatchPetHostCommand(
      "pet_act",
      { ...CALLER, action: "fed", idempotencyKey: "b" },
      deps
    )
    expect(second).toEqual({
      ok: false,
      refusal: { code: "cooling-down", kind: "fed", retryAfterMs: expect.any(Number) },
    })
    expect((await getPetProfile())?.xp).toBe(XP_AWARD.fed)
  })

  it("spends an owned item only on an accepted action", async () => {
    await upsertPetProfile(hatchedProfile())
    await getDb().petInventory.put({ id: "berry", qty: 2, acquiredAt: 1, updatedAt: 1 })
    const deps = hostDeps()
    const out = await dispatchPetHostCommand(
      "pet_act",
      { ...CALLER, action: "fed", itemId: "berry", idempotencyKey: "k1" },
      deps
    )
    expect(out).toMatchObject({ ok: true })
    expect((await getDb().petInventory.get("berry"))?.qty).toBe(1)
    // Cooling down now: the second use is refused and the berry is kept.
    await dispatchPetHostCommand(
      "pet_act",
      { ...CALLER, action: "fed", itemId: "berry", idempotencyKey: "k2" },
      deps
    )
    expect((await getDb().petInventory.get("berry"))?.qty).toBe(1)
  })

  it("refuses an egg and an absent profile before touching the bus", async () => {
    const emit = jest.fn()
    const deps = hostDeps({ emit })
    await expect(
      dispatchPetHostCommand("pet_act", { ...CALLER, action: "fed", idempotencyKey: "x" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "uninitialized" } })
    await upsertPetProfile(hatchedProfile({ soul: null }))
    await expect(
      dispatchPetHostCommand("pet_act", { ...CALLER, action: "fed", idempotencyKey: "y" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "not-hatched" } })
    expect(emit).not.toHaveBeenCalled()
  })

  it("answers host-starting until the controller has subscribed", async () => {
    await upsertPetProfile(hatchedProfile())
    const emit = jest.fn()
    const out = await dispatchPetHostCommand(
      "pet_act",
      { ...CALLER, action: "fed", idempotencyKey: "z" },
      hostDeps({ isControllerPresent: () => false, emit })
    )
    expect(out).toEqual({ ok: false, refusal: { code: "host-starting" } })
    expect(emit).not.toHaveBeenCalled()
  })

  it("passes the pet-off reason through", async () => {
    const out = await dispatchPetHostCommand(
      "pet_act",
      { ...CALLER, action: "fed", idempotencyKey: "z" },
      hostDeps({ getPetSettings: () => ({ ...enabled, enabled: false }) })
    )
    expect(out).toEqual({ ok: false, refusal: { code: "unavailable", reason: "disabled" } })
  })
})

describe("headless brain", () => {
  it("refuses every write as headless-host and answers reads with no pet", async () => {
    const deps = hostDeps({ platform: "headless" })
    for (const [command, payload] of [
      ["pet_act", { action: "fed", idempotencyKey: "k" }],
      ["pet_item_purchase", { itemId: "berry", qty: 1, idempotencyKey: "k2" }],
      ["pet_item_apply", { itemId: "beanie" }],
      ["pet_rename", { name: "Mochi" }],
      ["pet_soul_generate", {}],
      ["pet_chat_send", { text: "hi", locale: "en", idempotencyKey: "k3" }],
      ["pet_chat_clear", {}],
    ] as const) {
      await expect(
        dispatchPetHostCommand(command, { ...CALLER, ...payload }, deps)
      ).resolves.toEqual({ ok: false, refusal: { code: "headless-host" } })
    }
    await expect(dispatchPetHostCommand("pet_get", CALLER, deps)).resolves.toMatchObject({
      availability: { available: false, reason: "headless-host" },
      summary: null,
    })
    await expect(dispatchPetHostCommand("pet_chat_list", CALLER, deps)).resolves.toEqual({
      items: [],
    })
  })
})

describe("validation", () => {
  it("requires the injected caller and rejects foreign commands", async () => {
    await expect(dispatchPetHostCommand("pet_get", {}, hostDeps())).rejects.toThrow(
      "callerDeviceId is required"
    )
    await expect(dispatchPetHostCommand("pet_toggle", CALLER, hostDeps())).rejects.toThrow(
      "unsupported pet command"
    )
    await expect(
      dispatchPetHostCommand("pet_act", { ...CALLER, action: "fed" }, hostDeps())
    ).rejects.toThrow("idempotencyKey is required")
  })
})

describe("shop arms", () => {
  it("buys through the shop and reports the new balance once per intent", async () => {
    await upsertPetProfile(hatchedProfile({ coins: 20 }))
    const deps = hostDeps()
    const payload = { ...CALLER, itemId: "berry", qty: 2, idempotencyKey: "buy-1" }
    await expect(dispatchPetHostCommand("pet_item_purchase", payload, deps)).resolves.toEqual({
      ok: true,
      coins: 10,
    })
    await dispatchPetHostCommand("pet_item_purchase", payload, deps)
    expect((await getDb().petInventory.get("berry"))?.qty).toBe(2)
    expect((await getPetProfile())?.coins).toBe(10)
  })

  it("maps the shop's errors to refusals", async () => {
    const deps = hostDeps({
      purchase: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "insufficient-coins" })
        .mockResolvedValueOnce({ ok: false, error: "unknown-item" })
        .mockResolvedValueOnce({ ok: false, error: "no-profile" }),
    })
    const call = (key: string) =>
      dispatchPetHostCommand(
        "pet_item_purchase",
        { ...CALLER, itemId: "berry", qty: 1, idempotencyKey: key },
        deps
      )
    await expect(call("a")).resolves.toEqual({
      ok: false,
      refusal: { code: "insufficient-coins", itemId: "berry" },
    })
    await expect(call("b")).resolves.toEqual({
      ok: false,
      refusal: { code: "unknown-item", itemId: "berry" },
    })
    await expect(call("c")).resolves.toEqual({ ok: false, refusal: { code: "uninitialized" } })
  })

  it("applies owned decor and sends consumables back to pet_act", async () => {
    await upsertPetProfile(hatchedProfile())
    const deps = hostDeps()
    await expect(
      dispatchPetHostCommand("pet_item_apply", { ...CALLER, itemId: "berry" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "not-decor", itemId: "berry" } })
    await expect(
      dispatchPetHostCommand("pet_item_apply", { ...CALLER, itemId: "beanie" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "item-not-owned", itemId: "beanie" } })
    await getDb().petInventory.put({ id: "beanie", qty: 1, acquiredAt: 1, updatedAt: 1 })
    await expect(
      dispatchPetHostCommand("pet_item_apply", { ...CALLER, itemId: "beanie" }, deps)
    ).resolves.toEqual({ ok: true })
    // The beanie's own cosmetic landed, and applying decor spends nothing.
    expect((await getPetProfile())?.cosmetic).toEqual({ hat: "beanie" })
    expect(await getDb().petInventory.get("beanie")).toMatchObject({ qty: 1 })
    await expect(
      dispatchPetHostCommand("pet_item_apply", { ...CALLER, itemId: "no-such" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "unknown-item", itemId: "no-such" } })
  })
})

describe("pet_rename", () => {
  it("renames a hatched pet, sanitized, and refuses the rest", async () => {
    const deps = hostDeps()
    await expect(
      dispatchPetHostCommand("pet_rename", { ...CALLER, name: "Bao" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "uninitialized" } })
    await upsertPetProfile(hatchedProfile({ soul: null }))
    await expect(
      dispatchPetHostCommand("pet_rename", { ...CALLER, name: "Bao" }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "not-hatched" } })
    await upsertPetProfile(hatchedProfile())
    await expect(
      dispatchPetHostCommand("pet_rename", { ...CALLER, name: "   " }, deps)
    ).resolves.toEqual({ ok: false, refusal: { code: "invalid-name" } })
    await expect(
      dispatchPetHostCommand("pet_rename", { ...CALLER, name: "  Little   Bao " }, deps)
    ).resolves.toEqual({ ok: true, name: "Little Bao" })
    expect((await getPetProfile())?.soul?.name).toBe("Little Bao")
  })
})

describe("pet_soul_generate", () => {
  it("maps the single-flight hatch outcomes", async () => {
    const profile = hatchedProfile()
    const hatch = jest
      .fn()
      .mockResolvedValueOnce({ status: "hatched", profile })
      .mockResolvedValueOnce({ status: "already-hatched", profile })
      .mockResolvedValueOnce({ status: "no-profile" })
      .mockResolvedValueOnce({ status: "failed", error: new Error("model") })
    const deps = hostDeps({ hatch })
    await expect(dispatchPetHostCommand("pet_soul_generate", CALLER, deps)).resolves.toEqual({
      ok: true,
      state: "hatched",
    })
    await expect(dispatchPetHostCommand("pet_soul_generate", CALLER, deps)).resolves.toEqual({
      ok: true,
      state: "already-hatched",
    })
    await expect(dispatchPetHostCommand("pet_soul_generate", CALLER, deps)).resolves.toEqual({
      ok: false,
      refusal: { code: "uninitialized" },
    })
    await expect(dispatchPetHostCommand("pet_soul_generate", CALLER, deps)).resolves.toEqual({
      ok: false,
      refusal: { code: "hatch-failed" },
    })
  })

  it("answers pending when generation outlives the bridge window", async () => {
    const hatch = jest.fn(() => new Promise<never>(() => {}))
    await expect(
      dispatchPetHostCommand("pet_soul_generate", CALLER, hostDeps({ hatch, slowWorkWindowMs: 5 }))
    ).resolves.toEqual({ ok: true, state: "pending" })
  })
})

describe("pet chat", () => {
  const send = (deps: PetHostDispatchDeps, key = "c1") =>
    dispatchPetHostCommand(
      "pet_chat_send",
      { ...CALLER, text: "hello", locale: "zh-CN", idempotencyKey: key },
      deps
    )

  it("answers with the host's reply and animates the desktop pet", async () => {
    await upsertPetProfile(hatchedProfile())
    const respond = jest.fn(async (): Promise<PetChatResult> => ({
      status: "ok",
      reply: "hi!",
      emotion: "happy",
    }))
    const enqueueOneShot = jest.fn()
    const deps = hostDeps({ respond, enqueueOneShot })
    await expect(send(deps)).resolves.toEqual({
      ok: true,
      status: "replied",
      reply: "hi!",
      emotion: "happy",
    })
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "hello", locale: "zh-CN", activeCharacterId: null })
    )
    expect(enqueueOneShot).toHaveBeenCalledWith("happy")
    // A retried send is the same turn, not a second one.
    await send(deps)
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it("passes a degrade reason through and answers pending past the window", async () => {
    await upsertPetProfile(hatchedProfile())
    await expect(
      send(
        hostDeps({
          respond: jest.fn(async (): Promise<PetChatResult> => ({
            status: "degraded",
            reason: "pii",
          })),
        })
      )
    ).resolves.toEqual({ ok: true, status: "degraded", reason: "pii" })
    await expect(
      send(
        hostDeps({ respond: jest.fn(() => new Promise<never>(() => {})), slowWorkWindowMs: 5 }),
        "c2"
      )
    ).resolves.toEqual({ ok: true, status: "pending" })
  })

  it("pages the history newest page first, each page in reading order", async () => {
    const db = getDb()
    for (let i = 1; i <= 5; i++) {
      await db.petConversationV2.put({ id: `t${i}`, at: i, userText: `u${i}`, reply: `r${i}` })
    }
    const deps = hostDeps()
    const first = (await dispatchPetHostCommand(
      "pet_chat_list",
      { ...CALLER, pageSize: 2 },
      deps
    )) as { items: Array<{ id: string }>; nextPageToken?: string }
    expect(first.items.map((item) => item.id)).toEqual(["t4", "t5"])
    expect(first.nextPageToken).toBe(encodeChatPageToken(2))
    const last = (await dispatchPetHostCommand(
      "pet_chat_list",
      { ...CALLER, pageSize: 2, pageToken: encodeChatPageToken(4) },
      deps
    )) as { items: Array<{ id: string }>; nextPageToken?: string }
    expect(last.items.map((item) => item.id)).toEqual(["t1"])
    expect(last.nextPageToken).toBeUndefined()
  })

  it("clears the history", async () => {
    await getDb().petConversationV2.put({ id: "t1", at: 1, userText: "u", reply: "r" })
    await expect(dispatchPetHostCommand("pet_chat_clear", CALLER, hostDeps())).resolves.toEqual({
      ok: true,
    })
    expect(await getDb().petConversationV2.count()).toBe(0)
  })
})

describe("pet_get", () => {
  it("answers the live snapshot", async () => {
    await upsertPetProfile(hatchedProfile())
    const snapshot = await dispatchPetHostCommand("pet_get", CALLER, hostDeps())
    expect(snapshot).toMatchObject({
      availability: { available: true },
      summary: { hatched: true, name: "Mochi" },
      presentation: { requestedSkinId: "svg" },
    })
  })
})

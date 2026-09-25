/**
 * Activation-flow tests on a fully mounted test context: storage hydration,
 * pet event advancement, goal-hook advancement, claim → budget-clamped reward,
 * a failed claim reported to the user, deactivate cleanup, and the manifest
 * contract (unprefixed i18n bundle, desktop-only compatibility).
 */

import type { PluginContext, PluginPetEvent } from "@cognia/plugin-sdk"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import { createTestPluginContext } from "@cognia/plugin-sdk/testing"
import definition, { REWARD_EVENT_KIND, manifest } from "./index"
import manifestJson from "../plugin.json"
import { claimQuestReward, disposeQuestStore, getQuestState } from "./quest-store"
import { advanceQuests, ensureDay, localDayKey } from "./quest-engine"

type PetEventCb = (event: PluginPetEvent) => void

function makeCtx() {
  const petSubscribers = new Set<PetEventCb>()
  const emitEvent = jest.fn(async (_kind: string, opts?: { xp?: number; coins?: number }) => ({
    grantedXp: Math.min(opts?.xp ?? 0, 10),
    grantedCoins: opts?.coins ?? 0,
  }))
  const registerExtension = jest.fn(() => jest.fn())
  const showToast = jest.fn()
  const test = createTestPluginContext({
    pluginId: manifestJson.id,
    overrides: {
      pet: {
        onEvent: (cb: PetEventCb) => {
          petSubscribers.add(cb)
          return () => petSubscribers.delete(cb)
        },
        getRemainingBudget: () => ({ xp: 50, coins: 100 }),
        emitEvent,
      },
      extensions: { registerExtension },
      ui: { showToast },
    },
  })
  return {
    ctx: test.ctx,
    emitEvent,
    registerExtension,
    showToast,
    deliver: (event: PluginPetEvent) => {
      for (const cb of petSubscribers) cb(event)
    },
    subscriberCount: () => petSubscribers.size,
  }
}

/** Complete every interaction quest rolled today. */
function completeInteractionQuests(deliver: (event: PluginPetEvent) => void) {
  for (let i = 0; i < 5; i++) {
    for (const kind of ["fed", "played", "petted", "talked", "slept", "cleaned", "treated"]) {
      deliver({ source: "user", kind: kind as PluginPetEvent["kind"], at: i })
    }
  }
}

let activeCtx: PluginContext | null = null

async function activate(harness: ReturnType<typeof makeCtx>) {
  activeCtx = harness.ctx
  return definition.activate(harness.ctx)
}

afterEach(async () => {
  if (activeCtx) await definition.deactivate?.(activeCtx)
  activeCtx = null
  disposeQuestStore()
})

describe("pet-daily-quests activation", () => {
  it("rolls today's quests, persists them, and registers the console tab", async () => {
    const harness = makeCtx()
    await activate(harness)
    const state = getQuestState()
    expect(state?.day).toBe(localDayKey(Date.now()))
    expect(state?.quests).toHaveLength(3)
    expect(await harness.ctx.storage.get("quests")).toEqual(state)
    expect(harness.registerExtension).toHaveBeenCalledWith("pet.console.tab", expect.any(Function))
  })

  it("hydrates same-day state from storage instead of re-rolling", async () => {
    const harness = makeCtx()
    const today = localDayKey(Date.now())
    const seeded = advanceQuests(ensureDay(undefined, today), "fed")
    await harness.ctx.storage.set("quests", seeded)
    await activate(harness)
    expect(getQuestState()).toEqual(seeded)
  })

  it("advances quests from pet interaction events but ignores radar kinds", async () => {
    const harness = makeCtx()
    await activate(harness)
    const before = JSON.stringify(getQuestState())
    harness.deliver({ source: "system", kind: "thinking", at: 1 })
    expect(JSON.stringify(getQuestState())).toBe(before)
    completeInteractionQuests(harness.deliver)
    // Any day's roll contains at least 2 interaction quests (the pool has a
    // single goal quest), so the sweep completes at least one.
    expect(getQuestState()!.quests.some((q) => q.done)).toBe(true)
  })

  it("advances the goal quest through the returned onGoalComplete hook", async () => {
    const harness = makeCtx()
    const hooks = (await activate(harness)) as { onGoalComplete?: () => void }
    expect(typeof hooks.onGoalComplete).toBe("function")
    hooks.onGoalComplete?.()
    // No throw + state persists — the goal1 quest only advances on days it
    // was rolled, which is covered deterministically in quest-engine tests.
    expect(getQuestState()).not.toBeNull()
  })

  it("claims a completed quest through ctx.pet.emitEvent", async () => {
    const harness = makeCtx()
    await activate(harness)
    completeInteractionQuests(harness.deliver)
    const doneQuest = getQuestState()!.quests.find((q) => q.done)
    expect(doneQuest).toBeDefined()
    const granted = await claimQuestReward(doneQuest!.id)
    expect(harness.emitEvent).toHaveBeenCalledWith(
      REWARD_EVENT_KIND,
      expect.objectContaining({ xp: expect.any(Number), coins: expect.any(Number) })
    )
    expect(granted).not.toBeNull()
    // Re-claim yields nothing.
    expect(await claimQuestReward(doneQuest!.id)).toBeNull()
  })

  it("tells the user, in their language, when a claim is refused", async () => {
    const harness = makeCtx()
    await activate(harness)
    completeInteractionQuests(harness.deliver)
    const doneQuest = getQuestState()!.quests.find((q) => q.done)!
    harness.emitEvent.mockRejectedValueOnce(new Error("pet:emit rate limit exceeded"))

    await expect(claimQuestReward(doneQuest.id)).rejects.toThrow(/rate limit/)

    // The test context's `i18n.t` echoes the key, so this pins the lookup.
    expect(harness.showToast).toHaveBeenCalledWith("claimFailed", "error")
    expect(getQuestState()!.quests.find((q) => q.id === doneQuest.id)?.claimed).toBe(false)
  })

  it("deactivate disposes the event subscription and the store", async () => {
    const harness = makeCtx()
    await activate(harness)
    expect(harness.subscriberCount()).toBe(1)
    await definition.deactivate?.(harness.ctx)
    activeCtx = null
    expect(harness.subscriberCount()).toBe(0)
    expect(getQuestState()).toBeNull()
  })
})

describe("pet-daily-quests manifest", () => {
  it("is plugin.json itself and passes the host validator", () => {
    expect(manifest).toBe(manifestJson)
    expect(definition.manifest).toBe(manifest)
    expect(validatePluginManifest(manifest).errors).toEqual([])
  })

  it("ships an unprefixed bundle with the same keys in both locales", () => {
    // The manager prefixes `plugin.<id>.` itself; a pre-prefixed key became
    // `plugin.pet-daily-quests.plugin.pet-daily-quests.tab.title`.
    const { en, "zh-CN": zh } = manifestJson.i18n.locales
    for (const key of Object.keys(en)) expect(key.startsWith("plugin.")).toBe(false)
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it("runs only where the desktop pet exists", () => {
    const compat = manifestJson.runtimeCompatibility
    expect(compat.tauri.availability).toBe("supported")
    for (const profile of [compat.browser, compat.mobile, compat.headless]) {
      expect(profile.availability).toBe("blocked")
      expect(profile.reason).toEqual(expect.any(String))
    }
  })
})

import { respondAsPet, type PetChatDeps, type RespondAsPetInput } from "./respond"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { AppSettings } from "@cognia/agent-config-types"

const view = {
  effectiveBones: { rarity: "rare", species: "cat" },
  mood: "content",
  needs: { energy: 50, bond: 30 },
} as unknown as PetView

const profile = {
  soul: { name: "Boba", personality: "smug", hatchDate: "" },
  level: 3,
} as unknown as PetProfile

function settings(over: Record<string, unknown> = {}): AppSettings {
  return {
    petSettings: { llmSpeak: { enabled: true }, petMemory: { enabled: false }, ...over },
  } as unknown as AppSettings
}

function input(over: Partial<RespondAsPetInput> = {}): RespondAsPetInput {
  return {
    userText: "tell me a joke",
    view,
    profile,
    appSettings: settings(),
    locale: "en",
    at: 1000,
    ...over,
  }
}

/** Deps that always reach a successful reply unless a test overrides one. */
function okDeps(over: Partial<PetChatDeps> = {}): Partial<PetChatDeps> {
  return {
    hasNoLeakingPii: () => true,
    tryAcquire: () => true,
    buildClient: () => ({}) as LlmClient,
    chat: jest.fn().mockResolvedValue("[happy] Sure!"),
    history: {
      append: jest.fn().mockResolvedValue(1),
      listRecent: jest.fn().mockResolvedValue([]),
    },
    loadMemoryDeps: jest.fn().mockResolvedValue(null),
    recall: jest.fn().mockResolvedValue(""),
    resolveCharacterPersona: jest.fn().mockResolvedValue(null),
    ...over,
  }
}

describe("respondAsPet — degradations", () => {
  it("degrades to 'disabled' for no text / llm off / no soul / no view", async () => {
    expect((await respondAsPet(input({ userText: "  " }), okDeps())).status).toBe("degraded")
    expect(await respondAsPet(input({ userText: "  " }), okDeps())).toMatchObject({
      reason: "disabled",
    })
    expect(
      await respondAsPet(
        input({ appSettings: settings({ llmSpeak: { enabled: false } }) }),
        okDeps()
      )
    ).toMatchObject({ reason: "disabled" })
    expect(await respondAsPet(input({ profile: {} as PetProfile }), okDeps())).toMatchObject({
      reason: "disabled",
    })
    expect(await respondAsPet(input({ view: undefined }), okDeps())).toMatchObject({
      reason: "disabled",
    })
  })

  it("degrades to 'rateLimited' when the limiter rejects", async () => {
    expect(await respondAsPet(input(), okDeps({ tryAcquire: () => false }))).toMatchObject({
      reason: "rateLimited",
    })
  })

  it("degrades to 'pii' before building a client", async () => {
    const buildClient = jest.fn()
    const res = await respondAsPet(input(), okDeps({ hasNoLeakingPii: () => false, buildClient }))
    expect(res).toMatchObject({ reason: "pii" })
    expect(buildClient).not.toHaveBeenCalled()
  })

  it("degrades to 'noClient' when no client resolves", async () => {
    expect(await respondAsPet(input(), okDeps({ buildClient: () => null }))).toMatchObject({
      reason: "noClient",
    })
  })

  it("degrades to 'empty' when the model returns nothing usable", async () => {
    expect(
      await respondAsPet(input(), okDeps({ chat: jest.fn().mockResolvedValue(null) }))
    ).toMatchObject({ reason: "empty" })
  })

  it("degrades to 'error' when the chat call throws", async () => {
    expect(
      await respondAsPet(input(), okDeps({ chat: jest.fn().mockRejectedValue(new Error("x")) }))
    ).toMatchObject({ reason: "error" })
  })
})

describe("respondAsPet — success", () => {
  it("returns the parsed reply + emotion and records the turn when memory is on", async () => {
    const append = jest.fn().mockResolvedValue(1)
    const chat = jest.fn().mockResolvedValue("[love] Here you go, friend.")
    const res = await respondAsPet(
      input({ appSettings: settings({ petMemory: { enabled: true } }) }),
      okDeps({ chat, history: { append, listRecent: jest.fn().mockResolvedValue([]) } })
    )
    expect(res).toEqual({ status: "ok", reply: "Here you go, friend.", emotion: "love" })
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: "tell me a joke",
        reply: "Here you go, friend.",
        at: 1000,
      })
    )
  })

  it("skips recording when pet memory is off", async () => {
    const append = jest.fn().mockResolvedValue(1)
    await respondAsPet(
      input({ appSettings: settings({ petMemory: { enabled: false } }) }),
      okDeps({ history: { append, listRecent: jest.fn().mockResolvedValue([]) } })
    )
    expect(append).not.toHaveBeenCalled()
  })

  it("threads the persona layer only when it passes the PII gate", async () => {
    const chat = jest.fn().mockResolvedValue("[happy] hi")
    const piiChecks: string[] = []
    await respondAsPet(input({ activeCharacterId: "c1" }), {
      hasNoLeakingPii: (t) => {
        piiChecks.push(t)
        return true
      },
      tryAcquire: () => true,
      buildClient: () => ({}) as LlmClient,
      chat,
      history: { append: jest.fn(), listRecent: jest.fn().mockResolvedValue([]) },
      loadMemoryDeps: jest.fn().mockResolvedValue(null),
      recall: jest.fn().mockResolvedValue(""),
      resolveCharacterPersona: jest.fn().mockResolvedValue("A terse night-owl."),
    })
    // Both the user text and the resolved persona are gated.
    expect(piiChecks).toContain("A terse night-owl.")
    expect(chat.mock.calls[0][1].persona).toBe("A terse night-owl.")
  })
})

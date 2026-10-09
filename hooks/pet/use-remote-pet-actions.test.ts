/** @jest-environment jsdom */
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({
    target: { id: "m", kind: "companion", hostKind: "desktop", platform: "mobile" },
    vaultState: "unlocked",
    connectionState: "online",
  }),
}))
// The remote console must never touch the local pet: no bus event, no shop write.
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: jest.fn() }))
jest.mock("@/lib/pet/economy/shop", () => ({ purchaseItem: jest.fn(), consumeItem: jest.fn() }))

import { act, renderHook, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import type { PetRemoteClient } from "@/lib/pet/remote/client"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"
import {
  toPetChatLocale,
  useRemotePetActions,
  type UseRemotePetActionsDeps,
} from "./use-remote-pet-actions"

const snapshot: PetRemoteSnapshot = {
  availability: { available: true },
  summary: {
    hatched: true,
    name: "Boba",
    level: 2,
    stage: "baby",
    xp: 10,
    mood: "happy",
    needs: { energy: 50, mood: 50, bond: 50 },
    condition: "well",
    coins: 30,
    streak: { days: 1, lastDay: null, multiplier: 1 },
    cooldowns: { fed: 3000 },
  },
  presentation: {
    requestedSkinId: "live2d",
    desktopVisible: true,
    llmSpeakEnabled: true,
    chatEnabled: true,
  },
  hostTime: 1,
}

const client = {
  getSnapshot: jest.fn(),
  act: jest.fn(),
  purchase: jest.fn(),
  applyDecor: jest.fn(),
  rename: jest.fn(),
  hatch: jest.fn(),
  sendChat: jest.fn(),
  listChat: jest.fn(),
  clearChat: jest.fn(),
}
const pullMirror = jest.fn()
const deps: UseRemotePetActionsDeps = {
  getClient: () => client as unknown as PetRemoteClient,
  subscribe: () => () => undefined,
  now: () => 1_000,
  pullMirror,
}

beforeEach(() => {
  jest.clearAllMocks()
  client.getSnapshot.mockResolvedValue(snapshot)
  client.listChat.mockResolvedValue({ items: [] })
  pullMirror.mockResolvedValue([])
})

async function setup() {
  const hook = renderHook(() => useRemotePetActions(deps))
  await waitFor(() => expect(hook.result.current.remote?.snapshot).toBeDefined())
  return hook
}

describe("toPetChatLocale", () => {
  it("answers in one of the desktop's chat locales", () => {
    expect(toPetChatLocale("zh-CN")).toBe("zh-CN")
    expect(toPetChatLocale("zh")).toBe("zh-CN")
    expect(toPetChatLocale("en")).toBe("en")
    expect(toPetChatLocale("fr")).toBe("en")
  })
})

describe("useRemotePetActions", () => {
  it("presents the desktop's state and pulls a fresh mirror on arrival", async () => {
    const { result } = await setup()
    expect(result.current.mode).toBe("remote")
    expect(pullMirror).toHaveBeenCalledTimes(1)
    expect(result.current.desktop).toEqual({ visible: true, pending: false })
    expect(result.current.chat.enabled).toBe(true)
    expect(result.current.cooldownRemaining?.("fed")).toBe(3000)
    expect(result.current.remote?.connection).toBe("online")
  })

  it("labels the desktop-owned capabilities as such", async () => {
    const { result } = await setup()
    expect(result.current.capability("tab.customize")).toBe("desktop-only")
    expect(result.current.capability("binding.edit")).toBe("desktop-only")
    expect(result.current.capability("care")).toBe("available")
    await act(async () => {
      expect(await result.current.toggleDesktop()).toMatchObject({ reason: "desktop-only" })
      expect(await result.current.chat.enable()).toMatchObject({ reason: "desktop-only" })
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("sends care to the desktop, tells the reward, and re-reads the snapshot", async () => {
    client.act.mockResolvedValue({ ok: true, grantedXp: 4, grantedCoins: 2 })
    const { result } = await setup()
    const before = client.getSnapshot.mock.calls.length
    await act(async () => {
      expect(await result.current.care("fed")).toEqual({ ok: true })
    })
    expect(client.act).toHaveBeenCalledWith("fed", {})
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("4"))
    await waitFor(() => expect(client.getSnapshot.mock.calls.length).toBe(before + 1))
  })

  it("tells the user why the desktop refused, in the desktop's terms", async () => {
    client.act.mockResolvedValue({
      ok: false,
      refusal: { code: "unavailable", reason: "disabled" },
    })
    const { result } = await setup()
    await act(async () => {
      expect(await result.current.care("played")).toMatchObject({ ok: false, reason: "refused" })
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/switched off on your desktop/))
  })

  it("reports an unreachable desktop without throwing", async () => {
    client.act.mockRejectedValue(new Error("socket closed"))
    const { result } = await setup()
    await act(async () => {
      expect(await result.current.care("petted")).toMatchObject({
        ok: false,
        reason: "unreachable",
      })
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/reach your desktop/))
  })

  it("buys, uses and applies items on the desktop, never in this device's shop", async () => {
    client.purchase.mockResolvedValue({ ok: true, coins: 20 })
    client.act.mockResolvedValue({ ok: true, grantedXp: 1, grantedCoins: 0 })
    client.applyDecor.mockResolvedValue({ ok: true })
    const { result } = await setup()
    const berry = getPetItem("berry")!
    const charm = getPetItem("star-charm")!
    await act(async () => {
      await result.current.purchase(berry)
      await result.current.useItem(berry)
      await result.current.useItem(charm)
    })
    expect(client.purchase).toHaveBeenCalledWith("berry", 1)
    // A consumable is the care action that spends it, on the desktop.
    expect(client.act).toHaveBeenCalledWith(berry.interactionKind, { itemId: "berry" })
    expect(client.applyDecor).toHaveBeenCalledWith("star-charm")
    expect(purchaseItem).not.toHaveBeenCalled()
    expect(consumeItem).not.toHaveBeenCalled()
    expect(emitPetEvent).not.toHaveBeenCalled()
  })

  it("says a hatch is still running on the desktop", async () => {
    client.hatch.mockResolvedValue({ ok: true, state: "pending" })
    const { result } = await setup()
    await act(async () => {
      expect(await result.current.hatch()).toEqual({ ok: true, pending: true })
    })
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it("renames on the desktop", async () => {
    client.rename.mockResolvedValue({ ok: false, refusal: { code: "invalid-name" } })
    const { result } = await setup()
    await act(async () => {
      expect(await result.current.rename("  ")).toMatchObject({ ok: false })
    })
    expect(client.rename).toHaveBeenCalledWith("  ")
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/name/))
  })

  it("retries by asking the desktop again and pulling the mirror", async () => {
    const { result } = await setup()
    const calls = client.getSnapshot.mock.calls.length
    await act(async () => {
      await result.current.remote!.retry()
    })
    expect(client.getSnapshot.mock.calls.length).toBe(calls + 1)
    expect(pullMirror).toHaveBeenCalledTimes(2)
  })

  it("never emits on the local pet bus", async () => {
    client.act.mockResolvedValue({ ok: true, grantedXp: 0, grantedCoins: 0 })
    client.sendChat.mockResolvedValue({ ok: true, status: "replied", reply: "hey" })
    const { result } = await setup()
    await act(async () => {
      for (const kind of [
        "fed",
        "played",
        "petted",
        "talked",
        "slept",
        "cleaned",
        "treated",
      ] as const) {
        await result.current.care(kind, { text: "words" })
      }
      await result.current.chat.send("hi")
    })
    expect(emitPetEvent).not.toHaveBeenCalled()
    // A remote talk is the plain care action: words go through chat.
    expect(client.act).toHaveBeenCalledWith("talked", {})
  })
})

/** @jest-environment jsdom */
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/pet/use-pet-chat", () => ({ usePetChat: jest.fn() }))
jest.mock("@/lib/pet/runtime/hatch", () => ({ hatchPetOnce: jest.fn() }))
jest.mock("@/lib/pet/runtime/rename-pet", () => ({
  renamePet: jest.fn(),
  isValidPetName: (name: string) => name.trim().length > 0 && !name.includes("@"),
}))
jest.mock("@/lib/pet/commands", () => ({ toggleDesktopPetWindow: jest.fn() }))
jest.mock("@/lib/pet/settings-sync", () => ({ updatePetSettings: jest.fn() }))
jest.mock("@/lib/db/pet-conversation", () => ({ clearPetConversation: jest.fn() }))
jest.mock("@/lib/pet/economy/shop", () => ({ purchaseItem: jest.fn(), consumeItem: jest.fn() }))
let mockSettings: unknown = { petSettings: { desktopPet: { enabled: false } } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: { settings: unknown }) => unknown) =>
    select({ settings: mockSettings }),
}))

import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { usePetChat } from "@/hooks/pet/use-pet-chat"
import type { UsePetResult } from "@/hooks/pet/use-pet"
import { hatchPetOnce } from "@/lib/pet/runtime/hatch"
import { renamePet } from "@/lib/pet/runtime/rename-pet"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import { updatePetSettings } from "@/lib/pet/settings-sync"
import { clearPetConversation } from "@/lib/db/pet-conversation"
import { purchaseItem } from "@/lib/pet/economy/shop"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { PET_CONSOLE_CAPABILITY_IDS } from "@/lib/pet/console/action-capabilities"
import { useLocalPetActions } from "./use-local-pet-actions"

const chatSend = jest.fn()
function pet(): UsePetResult {
  return {
    profile: undefined,
    view: undefined,
    loading: false,
    binding: undefined,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
    sleep: jest.fn(),
    clean: jest.fn(),
    treat: jest.fn(),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = { petSettings: { desktopPet: { enabled: false } } }
  ;(usePetChat as jest.Mock).mockReturnValue({
    turns: [],
    pending: null,
    degradeReason: null,
    inFlight: false,
    send: chatSend,
  })
})

function setup(state = pet()) {
  return { state, ...renderHook(() => useLocalPetActions({ pet: state, activeCharacterId: "c1" })) }
}

describe("useLocalPetActions", () => {
  it("is the desktop's console: every capability, no remote state", () => {
    const { result } = setup()
    expect(result.current.mode).toBe("local")
    expect(result.current.remote).toBeNull()
    expect(result.current.cooldownRemaining).toBeUndefined()
    for (const id of PET_CONSOLE_CAPABILITY_IDS) {
      expect(result.current.capability(id)).toBe("available")
    }
    expect(usePetChat).toHaveBeenCalledWith(expect.objectContaining({ activeCharacterId: "c1" }))
  })

  it("emits each care action through the pet's own events, talk text included", async () => {
    const { result, state } = setup()
    await act(async () => {
      for (const kind of ["fed", "played", "petted", "slept", "cleaned", "treated"] as const) {
        expect(await result.current.care(kind)).toEqual({ ok: true })
      }
      await result.current.care("talked", { text: "hello" })
    })
    expect(state.feed).toHaveBeenCalledTimes(1)
    expect(state.play).toHaveBeenCalledTimes(1)
    expect(state.petStroke).toHaveBeenCalledTimes(1)
    expect(state.sleep).toHaveBeenCalledTimes(1)
    expect(state.clean).toHaveBeenCalledTimes(1)
    expect(state.treat).toHaveBeenCalledTimes(1)
    expect(state.talk).toHaveBeenCalledWith("hello")
  })

  it("buys from this device's shop", async () => {
    ;(purchaseItem as jest.Mock).mockResolvedValue({ ok: true, coins: 1 })
    const { result } = setup()
    await act(async () => {
      await result.current.purchase(getPetItem("berry")!)
    })
    expect(purchaseItem).toHaveBeenCalledWith("berry")
  })

  it("hatches through the single-flight hatch and reports every failure", async () => {
    mockSettings = { defaultProvider: "openai" }
    const { result } = setup()
    ;(hatchPetOnce as jest.Mock).mockResolvedValueOnce({ status: "hatched", profile: {} })
    ;(hatchPetOnce as jest.Mock).mockResolvedValueOnce({ status: "failed", error: new Error() })
    ;(hatchPetOnce as jest.Mock).mockResolvedValueOnce({ status: "no-profile" })
    await act(async () => {
      expect(await result.current.hatch()).toEqual({ ok: true })
      expect(await result.current.hatch()).toMatchObject({ ok: false, reason: "failed" })
      expect(await result.current.hatch()).toMatchObject({ ok: false, reason: "refused" })
    })
    expect(hatchPetOnce).toHaveBeenCalledWith({ defaultProvider: "openai" })
    expect(toast.error).toHaveBeenCalledTimes(2)
  })

  it("refuses an unusable name without writing it", async () => {
    const { result } = setup()
    await act(async () => {
      expect(await result.current.rename("alice@example.com")).toMatchObject({
        ok: false,
        reason: "refused",
      })
    })
    expect(renamePet).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/can't be used/i))
  })

  it("says so when a rename fails", async () => {
    ;(renamePet as jest.Mock).mockRejectedValue(new Error("db"))
    const { result } = setup()
    await act(async () => {
      expect(await result.current.rename("Mochi")).toMatchObject({ ok: false })
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/rename/i))
  })

  it("toggles the desktop pet with a pending state and reports a window that would not open", async () => {
    let finish!: (open: boolean) => void
    ;(toggleDesktopPetWindow as jest.Mock).mockReturnValue(
      new Promise<boolean>((resolve) => (finish = resolve))
    )
    const { result } = setup()
    expect(result.current.desktop).toEqual({ visible: false, pending: false })
    let run!: Promise<unknown>
    act(() => {
      run = result.current.toggleDesktop()
    })
    expect(result.current.desktop.pending).toBe(true)
    await act(async () => {
      finish(false)
      expect(await run).toMatchObject({ ok: false })
    })
    expect(result.current.desktop.pending).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it("reads whether the pet is out on the desktop from its settings", () => {
    mockSettings = { petSettings: { desktopPet: { enabled: true } } }
    expect(setup().result.current.desktop.visible).toBe(true)
  })

  describe("chat", () => {
    it("is enabled by the pet's LLM speak setting and turns it on through the lock", async () => {
      mockSettings = { petSettings: { llmSpeak: { enabled: false } } }
      ;(updatePetSettings as jest.Mock).mockResolvedValue({})
      const { result } = setup()
      expect(result.current.chat.enabled).toBe(false)
      await act(async () => {
        expect(await result.current.chat.enable()).toEqual({ ok: true })
      })
      const updater = (updatePetSettings as jest.Mock).mock.calls[0]![0]
      expect(updater({ llmSpeak: { enabled: false, model: "m" } })).toEqual({
        llmSpeak: { enabled: true, model: "m" },
      })
    })

    it("sends through the local chat and clears the local transcript", async () => {
      ;(clearPetConversation as jest.Mock).mockResolvedValue(undefined)
      const { result } = setup()
      await act(async () => {
        await result.current.chat.send("hi")
        expect(await result.current.chat.clear()).toEqual({ ok: true })
        expect(await result.current.chat.refresh()).toEqual({ ok: true })
      })
      expect(chatSend).toHaveBeenCalledWith("hi")
      expect(toast.success).toHaveBeenCalledTimes(1)
    })

    it("keeps refresh stable across renders, so the chat tab loads once", () => {
      const { result, rerender } = setup()
      const first = result.current.chat.refresh
      rerender()
      expect(result.current.chat.refresh).toBe(first)
    })
  })
})

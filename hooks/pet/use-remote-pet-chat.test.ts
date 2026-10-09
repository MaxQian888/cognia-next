/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { PetRemoteClient } from "@/lib/pet/remote/client"
import type { PetChatListResult, PetChatSendResult } from "@/lib/pet/remote/types"
import { useRemotePetChat, type UseRemotePetChatDeps } from "./use-remote-pet-chat"

const listChat = jest.fn<Promise<PetChatListResult>, [unknown?]>()
const sendChat = jest.fn<Promise<PetChatSendResult>, [string, string, unknown?]>()
const clearChat = jest.fn()
const client = { listChat, sendChat, clearChat } as unknown as PetRemoteClient
const deps: UseRemotePetChatDeps = {
  getClient: () => client,
  now: () => 100_000,
  pendingPollsMs: [1_000, 2_000],
}

const turn = (id: string, userText: string, at = 100_500) => ({
  id,
  at,
  userText,
  reply: `re: ${userText}`,
})

beforeEach(() => {
  listChat.mockReset().mockResolvedValue({ items: [] })
  sendChat.mockReset()
  clearChat.mockReset()
})

function setup(enabled = true) {
  return renderHook(() => useRemotePetChat({ enabled, locale: "zh-CN" }, deps))
}

describe("useRemotePetChat", () => {
  it("loads the desktop's transcript on request, newest page", async () => {
    listChat.mockResolvedValue({ items: [turn("a", "hi")] })
    const { result } = setup()
    expect(result.current.turns).toBeUndefined()
    await act(async () => {
      expect(await result.current.refresh()).toEqual({ ok: true })
    })
    expect(listChat).toHaveBeenCalledWith({ pageSize: 50 })
    expect(result.current.turns).toEqual([turn("a", "hi")])
  })

  it("reports an unreachable desktop instead of throwing", async () => {
    listChat.mockRejectedValue(new Error("offline"))
    const { result } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.refresh()
    })
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable" })
    expect(result.current.turns).toBeUndefined()
  })

  it("shows a reply at once and sends the phone's locale", async () => {
    sendChat.mockResolvedValue({ ok: true, status: "replied", reply: "hello!" })
    listChat.mockResolvedValue({ items: [turn("real", "hi")] })
    const { result } = setup()
    await act(async () => {
      await result.current.send("  hi  ")
    })
    expect(sendChat).toHaveBeenCalledWith("hi", "zh-CN")
    expect(result.current.pending).toBeNull()
    expect(result.current.inFlight).toBe(false)
    // The desktop's own row replaces the optimistic one.
    expect(result.current.turns).toEqual([turn("real", "hi")])
  })

  it("keeps a degraded turn on screen under its reason", async () => {
    sendChat.mockResolvedValue({ ok: true, status: "degraded", reason: "rateLimited" })
    const { result } = setup()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(result.current.pending).toBe("hi")
    expect(result.current.degradeReason).toBe("rateLimited")
  })

  it("turns a refusal into an outcome and drops the pending text", async () => {
    sendChat.mockResolvedValue({ ok: false, refusal: { code: "host-starting" } })
    const { result } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.send("hi")
    })
    expect(outcome).toEqual({
      ok: false,
      reason: "refused",
      message: { key: "outcomes.remote.hostStarting" },
    })
    expect(result.current.pending).toBeNull()
  })

  it("waits for a pending reply by polling until the recorded turn appears", async () => {
    jest.useFakeTimers()
    try {
      sendChat.mockResolvedValue({ ok: true, status: "pending" })
      const { result } = setup()
      let outcome: unknown
      await act(async () => {
        outcome = await result.current.send("slow one")
      })
      expect(outcome).toEqual({ ok: true, pending: true })
      expect(result.current.awaitingReply).toBe(true)
      expect(result.current.pending).toBe("slow one")

      // First poll: not there yet.
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      expect(listChat).toHaveBeenCalledTimes(1)
      expect(result.current.awaitingReply).toBe(true)

      // Second poll: the desktop recorded it.
      listChat.mockResolvedValue({ items: [turn("t1", "slow one")] })
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      expect(result.current.awaitingReply).toBe(false)
      expect(result.current.pending).toBeNull()
      expect(result.current.turns).toEqual([turn("t1", "slow one")])
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not send twice while a turn is in flight", async () => {
    let finish!: (r: PetChatSendResult) => void
    sendChat.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const { result } = setup()
    let first!: Promise<unknown>
    act(() => {
      first = result.current.send("one")
    })
    await act(async () => {
      await result.current.send("two")
    })
    expect(sendChat).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ ok: true, status: "degraded", reason: "error" })
      await first
    })
  })

  it("clears the desktop's conversation", async () => {
    listChat.mockResolvedValue({ items: [turn("a", "hi")] })
    clearChat.mockResolvedValue({ ok: true })
    const { result } = setup()
    await act(async () => {
      await result.current.refresh()
    })
    await act(async () => {
      expect(await result.current.clear()).toEqual({ ok: true })
    })
    expect(result.current.turns).toEqual([])

    clearChat.mockRejectedValue(new Error("offline"))
    await act(async () => {
      expect(await result.current.clear()).toMatchObject({ ok: false, reason: "unreachable" })
    })
  })

  it("reads nothing while disabled", async () => {
    const { result } = setup(false)
    await act(async () => {
      await result.current.refresh()
    })
    expect(listChat).not.toHaveBeenCalled()
  })
})

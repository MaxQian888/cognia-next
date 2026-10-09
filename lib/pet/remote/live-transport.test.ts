/** @jest-environment jsdom */
import type { Transport } from "@/lib/tauri/transport-types"
import { setTransport } from "@/lib/tauri/transport-instance"
import { PET_REMOTE_COMMANDS } from "./commands"
import { livePetRemoteClient, subscribeLivePetTransport } from "./live-transport"

function fakeTransport(): Transport & {
  call: jest.Mock
  subscribe: jest.Mock
  unsubscribe: jest.Mock
} {
  const unsubscribe = jest.fn()
  return {
    call: jest.fn().mockResolvedValue({ ok: true }),
    subscribe: jest.fn(() => unsubscribe),
    unsubscribe,
  } as unknown as Transport & { call: jest.Mock; subscribe: jest.Mock; unsubscribe: jest.Mock }
}

describe("live pet transport", () => {
  it("calls whichever transport is installed when the call is made", async () => {
    const first = fakeTransport()
    setTransport(first)
    await livePetRemoteClient().clearChat()
    expect(first.call).toHaveBeenCalledWith(
      PET_REMOTE_COMMANDS.chatClear,
      {},
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )

    const second = fakeTransport()
    setTransport(second)
    await livePetRemoteClient().clearChat()
    expect(second.call).toHaveBeenCalledTimes(1)
    expect(first.call).toHaveBeenCalledTimes(1)
  })

  it("follows a subscription across a transport swap and releases both", () => {
    const first = fakeTransport()
    setTransport(first)
    const handler = jest.fn()
    const stop = subscribeLivePetTransport("sync://invalidate", handler)
    expect(first.subscribe).toHaveBeenCalledWith("sync://invalidate", handler)

    const second = fakeTransport()
    setTransport(second)
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(second.subscribe).toHaveBeenCalledWith("sync://invalidate", handler)

    stop()
    expect(second.unsubscribe).toHaveBeenCalledTimes(1)
    // No longer following: a later swap subscribes nothing.
    const third = fakeTransport()
    setTransport(third)
    expect(third.subscribe).not.toHaveBeenCalled()
  })
})

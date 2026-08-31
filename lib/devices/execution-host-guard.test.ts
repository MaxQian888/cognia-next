/**
 * @jest-environment jsdom
 */
const getState = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({ useChatStore: { getState: () => getState() } }))

import { anyRunActive } from "./execution-host-guard"

beforeEach(() => getState.mockReset())

it("reports work in flight anywhere, not just the focused conversation", async () => {
  getState.mockReturnValue({
    sessions: { a: { status: "idle" }, b: { status: "streaming" } },
    activeSessionId: "a",
  })
  await expect(anyRunActive()).resolves.toBe(true)
})

it("counts an approval the user has not been shown", async () => {
  getState.mockReturnValue({
    sessions: { a: { status: "awaiting_approval" } },
    activeSessionId: null,
  })
  await expect(anyRunActive()).resolves.toBe(true)
})

/**
 * A turn that already failed is not work in flight. Treating it as one would
 * make every host switch prompt forever after a single background error.
 */
it("does not count a conversation that has already failed", async () => {
  getState.mockReturnValue({ sessions: { a: { status: "error" } }, activeSessionId: "a" })
  await expect(anyRunActive()).resolves.toBe(false)
})

/**
 * Fails open. Blocking a host switch behind a store-load failure would leave
 * the user unable to change machines at all, which is worse than the race.
 */
it("reports nothing running when the store cannot be read", async () => {
  getState.mockImplementation(() => {
    throw new Error("store unavailable")
  })
  await expect(anyRunActive()).resolves.toBe(false)
})

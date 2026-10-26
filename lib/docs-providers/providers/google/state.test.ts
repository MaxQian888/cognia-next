jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))
import { transport } from "@/lib/tauri/transport-instance"
import {
  __setGoogleStatePortForTests,
  googleState,
  subscribeGoogleStateChanged,
  type GoogleStateReply,
} from "./state"
const call = transport.call as jest.Mock
const subscribe = transport.subscribe as jest.Mock
const reply: GoogleStateReply = {
  state: {
    version: 1,
    connection: "c",
    authorization: "a",
    tokens: null,
    pending: null,
    claimed: false,
    accountEmail: null,
    legacyMetadata: false,
  },
  pending: null,
  outcome: null,
}
beforeEach(() => {
  jest.clearAllMocks()
  __setGoogleStatePortForTests(null)
  call.mockResolvedValue(reply)
  subscribe.mockReturnValue(jest.fn())
})
afterEach(() => __setGoogleStatePortForTests(null))
it("sends guarded transitions to the selected host without a renderer storage fallback", async () => {
  await expect(googleState({ action: "invalidate", connection: "old-generation" })).resolves.toBe(
    reply
  )
  expect(call).toHaveBeenCalledWith("connectors_google_docs_auth", {
    input: { action: "invalidate", connection: "old-generation" },
  })
})
it.each([
  ["google_docs_state_stale", "connection changed"],
  [new Error("google_docs_state_mismatch"), "oauth state mismatch"],
])("maps host fences to typed authorization errors: %s", async (error, reason) => {
  call.mockRejectedValue(error)
  await expect(googleState({ action: "claim", state: "s", now: 0 })).rejects.toMatchObject({
    code: "notAuthorized",
    params: { reason },
  })
})
it("preserves actual storage/transport failures", async () => {
  const error = new Error("disk unavailable")
  call.mockRejectedValue(error)
  await expect(googleState({ action: "disconnect" })).rejects.toBe(error)
})
it("shares the native signal subscription and releases it after the last observer", () => {
  const first = jest.fn(),
    second = jest.fn(),
    stop = jest.fn()
  subscribe.mockReturnValue(stop)
  const offA = subscribeGoogleStateChanged(first),
    offB = subscribeGoogleStateChanged(second)
  try {
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0][0]).toBe("google-docs-connection-changed")
    const signal = subscribe.mock.calls[0][1] as () => void
    signal()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offA()
    signal()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(stop).not.toHaveBeenCalled()
  } finally {
    offA()
    offB()
  }
  expect(stop).toHaveBeenCalledTimes(1)
})
it("notifies local observers after mutations, including failed cleanup, but never on reads", async () => {
  const listener = jest.fn()
  const off = subscribeGoogleStateChanged(listener)
  try {
    await googleState({ action: "snapshot" })
    expect(listener).not.toHaveBeenCalled()
    await googleState({ action: "begin" })
    expect(listener).toHaveBeenCalledTimes(1)
    call.mockRejectedValueOnce(new Error("write failed"))
    await expect(googleState({ action: "disconnect" })).rejects.toThrow("write failed")
    expect(listener).toHaveBeenCalledTimes(2)
  } finally {
    off()
  }
})

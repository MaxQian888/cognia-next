import { transport } from "@/lib/tauri"
import {
  HOST_CONSENT_CHANNEL,
  listPendingHostConsent,
  respondToHostConsent,
  subscribeToHostConsent,
} from "./client"

afterEach(() => jest.restoreAllMocks())

describe("host consent client", () => {
  it("lists what this device may answer", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue([])
    await listPendingHostConsent()
    expect(call).toHaveBeenCalledWith("host_consent_pending")
  })

  it("sends no lease with the answer", async () => {
    // The command it answers is the one that mints leases; requiring one here
    // would be a loop with no entry.
    const call = jest.spyOn(transport, "call").mockResolvedValue({})
    await respondToHostConsent("req-1", true)
    expect(call).toHaveBeenCalledWith("host_consent_respond", {
      requestId: "req-1",
      approve: true,
    })
  })

  it("carries a denial as explicitly as an approval", async () => {
    const call = jest.spyOn(transport, "call").mockResolvedValue({})
    await respondToHostConsent("req-1", false)
    expect(call).toHaveBeenCalledWith("host_consent_respond", {
      requestId: "req-1",
      approve: false,
    })
  })

  it("subscribes on the one channel that carries both the ask and the answer", () => {
    const off = jest.fn()
    const subscribe = jest.spyOn(transport, "subscribe").mockReturnValue(off)
    const handler = jest.fn()

    expect(subscribeToHostConsent(handler)).toBe(off)
    expect(subscribe).toHaveBeenCalledWith(HOST_CONSENT_CHANNEL, handler)
  })
})

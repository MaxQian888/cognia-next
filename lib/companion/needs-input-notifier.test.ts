/** @jest-environment jsdom */
import {
  NEEDS_INPUT_CHANNEL,
  buildNeedsInputEmit,
  needsInputHref,
  notifyRemoteNeedsInput,
} from "./needs-input-notifier"
import {
  __resetDevicePresenceForTests,
  attachSessionLease,
  setDeviceAttention,
  syncEventStreams,
} from "./device-presence-registry"

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it, and
// explicitly typed rather than a spread — a `unknown[]` rest argument does not
// satisfy the mock's tuple signature (TS2556).
const mockEmit = jest.fn(async (_channel: string, _payload: unknown) => undefined)
// The notifier is host-neutral: it hands the frame to the shared host event
// publisher, which is a Tauri emit on the desktop and the bridge route on the
// headless brain. What is asserted here is the topic and the audience.
jest.mock("@/lib/companion/host-event-publisher", () => ({
  publishHostEvent: (channel: string, payload: unknown) => mockEmit(channel, payload),
}))

beforeEach(() => {
  __resetDevicePresenceForTests()
  mockEmit.mockClear()
})

afterEach(() => {
  __resetDevicePresenceForTests()
})

/** `notifyRemoteNeedsInput` reads the wall clock, so leases must be minted
 *  against it — a fixed epoch would be 50 years expired. */
function attachController(sessionId: string, deviceId: string, at = Date.now()) {
  const leaseId = `esl_${deviceId}`
  syncEventStreams({
    deviceId,
    streams: [{ leaseId, transport: "ws", state: "ready", openedAt: at }],
    at,
  })
  attachSessionLease({
    sessionId,
    deviceId,
    mode: "control",
    eventStreamLeaseId: leaseId,
    at,
  })
  return leaseId
}

describe("buildNeedsInputEmit", () => {
  /**
   * The payload's whole job is routing. Anything describing *what* the run
   * wants to do would reach APNs/FCM and can surface on a lock screen.
   */
  it("carries ids, a deep link and the audience — and nothing about the tool", () => {
    const payload = buildNeedsInputEmit({ sessionId: "s-1", requestId: "req-1" }, ["dev-a"])

    expect(payload).toEqual({
      sessionId: "s-1",
      requestId: "req-1",
      targetDeviceIds: ["dev-a"],
      href: "/remote-sessions?session=s-1&decision=req-1",
      dedupeKey: "req-1",
    })
    expect(JSON.stringify(payload)).not.toMatch(/tool/i)
  })

  it("dedupes on the request id so a re-emit collapses instead of stacking", () => {
    const first = buildNeedsInputEmit({ sessionId: "s-1", requestId: "req-1" }, ["dev-a"])
    const second = buildNeedsInputEmit({ sessionId: "s-1", requestId: "req-1" }, ["dev-a", "dev-b"])
    expect(second.dedupeKey).toBe(first.dedupeKey)
  })

  it("percent-encodes ids so a crafted session id cannot forge a query parameter", () => {
    expect(needsInputHref("s&decision=evil", "req-1")).toBe(
      "/remote-sessions?session=s%26decision%3Devil&decision=req-1"
    )
  })
})

describe("notifyRemoteNeedsInput", () => {
  it("emits to the attached controller when it is not already watching", async () => {
    attachController("s-1", "dev-a")
    setDeviceAttention("dev-a", "background", Date.now())

    await notifyRemoteNeedsInput({ sessionId: "s-1", requestId: "req-1" })

    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith(
      NEEDS_INPUT_CHANNEL,
      expect.objectContaining({ targetDeviceIds: ["dev-a"], requestId: "req-1" })
    )
  })

  /**
   * The regression this replaced. The old notifier emitted unconditionally and
   * the Rust trigger fanned out to every registered device — waking phones for
   * prompts they had no authority to answer, and telling them a session they
   * were never watching had gone active.
   */
  it("does not emit at all when no attached device could act on it", async () => {
    await notifyRemoteNeedsInput({ sessionId: "s-nobody", requestId: "req-1" })
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it("does not emit for a controller already foreground on a live stream", async () => {
    attachController("s-1", "dev-a")
    setDeviceAttention("dev-a", "foreground", Date.now())

    await notifyRemoteNeedsInput({ sessionId: "s-1", requestId: "req-1" })
    expect(mockEmit).not.toHaveBeenCalled()
  })

  /**
   * The regression this replaced: the emit was a bare `@tauri-apps/api/event`
   * import behind `isTauri()`, so the headless brain — where a backgrounded
   * phone most needs the alert — never published at all.
   */
  it("publishes through the host event publisher, never a Tauri-only import", async () => {
    attachController("s-1", "dev-a")
    setDeviceAttention("dev-a", "background", Date.now())

    await notifyRemoteNeedsInput({ sessionId: "s-1", requestId: "req-1" })

    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit.mock.calls[0]?.[0]).toBe(NEEDS_INPUT_CHANNEL)
  })
})

/**
 * @jest-environment jsdom
 */
/**
 * Driven through the PRODUCTION `persistCapture`, which is the only writer of
 * `capturedItems` in the app.
 */
import "fake-indexeddb/auto"

const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

const hasNoLeakingPii = jest.fn((_t: string) => true)
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: (t: string) => hasNoLeakingPii(t) }))

import { persistCapture } from "@/lib/capture/capture-manager"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"
import { disposeCaptureEventTrigger, initCaptureEventTrigger } from "./capture-event-trigger"

function seedWorkflow(params: Record<string, unknown>, id = "wf1") {
  _seedTriggerSubscriptionsForTest([
    { id, nodes: [{ id: "t1", type: "trigger.capture.item", data: { params } }] },
  ] as never)
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

let counter = 0
function candidate(over: Record<string, unknown> = {}) {
  counter += 1
  return {
    kind: "url",
    text: "my private clipboard contents",
    sourceUrl: "https://example.com/deep/path?token=secret123",
    sourceApp: "Safari",
    fingerprint: `fp_${counter}`,
    ...over,
  } as never
}

/** No enrichment: the url reader is not what this test is about. */
const deps = { enrich: async () => undefined } as never

beforeEach(async () => {
  jest.clearAllMocks()
  hasNoLeakingPii.mockReturnValue(true)
  const { getDb } = await import("@/lib/db/schema")
  await getDb().capturedItems.clear()
})

afterEach(() => disposeCaptureEventTrigger())

it("carries a real persistCapture through to a dispatched run", async () => {
  seedWorkflow({})
  initCaptureEventTrigger()

  await persistCapture(candidate(), { deps })
  await settle()

  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    kind: "trigger.capture.item",
    payload: expect.objectContaining({ kind: "url" }),
  })
})

it("carries the host of the source url and never its path or query", async () => {
  // The query string is where the tracking identifiers live.
  seedWorkflow({})
  initCaptureEventTrigger()

  await persistCapture(candidate(), { deps })
  await settle()

  const payload = JSON.stringify(dispatchTrigger.mock.calls[0][0])
  expect(payload).toContain("example.com")
  expect(payload).not.toContain("deep/path")
  expect(payload).not.toContain("secret123")
})

it("withholds the captured text unless the node asks for it", async () => {
  seedWorkflow({})
  initCaptureEventTrigger()
  await persistCapture(candidate(), { deps })
  await settle()
  expect(JSON.stringify(dispatchTrigger.mock.calls[0][0])).not.toContain("private clipboard")

  dispatchTrigger.mockClear()
  // A different workflow, because the runner's cooldown is per workflow and
  // this second capture lands well inside it.
  seedWorkflow({ includeText: true }, "wf2")
  await persistCapture(candidate(), { deps })
  await settle()
  expect(JSON.stringify(dispatchTrigger.mock.calls[0][0])).toContain("private clipboard")
})

it("omits text the redaction gate refuses, rather than blanking it", async () => {
  seedWorkflow({ includeText: true })
  initCaptureEventTrigger()
  hasNoLeakingPii.mockReturnValue(false)

  await persistCapture(candidate(), { deps })
  await settle()

  const payload = dispatchTrigger.mock.calls[0][0] as { payload: Record<string, unknown> }
  expect(payload.payload.text).toBeUndefined()
  expect(payload.payload.sourceApp).toBeUndefined()
  expect(payload.payload.captureId).toBeDefined()
})

it("honours the kinds filter", async () => {
  seedWorkflow({ kinds: ["image"] })
  initCaptureEventTrigger()
  await persistCapture(candidate({ kind: "url" }), { deps })
  await settle()
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

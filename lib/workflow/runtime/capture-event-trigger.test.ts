/**
 * @jest-environment jsdom
 */
/**
 * Unit-level behaviour of the runner. The production chain from
 * `persistCapture` through to a dispatched run lives in the sibling
 * `.live.test.ts`.
 */
const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

const findMatchingWorkflows = jest.fn((_k: string, _c: unknown) => [
  { workflowId: "wf1", nodeId: "t1", params: {} },
])
jest.mock("./trigger-subscriptions", () => ({
  findMatchingWorkflows: (k: string, c: unknown) => findMatchingWorkflows(k, c),
}))

const getCapturedItem = jest.fn(async (_id: string): Promise<unknown> => ({
  id: "cap1",
  kind: "url",
  capturedAt: 1000,
  text: "clipboard contents",
  sourceUrl: "https://example.com/a/b?utm=1",
  sourceApp: "Safari",
}))
jest.mock("@/lib/db/captured-items", () => ({
  getCapturedItem: (id: string) => getCapturedItem(id),
}))

const gateModelText = jest.fn(
  async (t: string | undefined, _max?: number): Promise<string | undefined> => t
)
jest.mock("@/lib/runtime/completion-linkage-core", () => ({
  gateModelText: (t: string | undefined, n?: number) => gateModelText(t, n),
}))

import {
  _injectCapturePersistedForTest,
  disposeCaptureEventTrigger,
  initCaptureEventTrigger,
} from "./capture-event-trigger"

const EVENT = { captureId: "cap1", kind: "url", capturedAt: 1000 }

beforeEach(() => {
  jest.clearAllMocks()
  gateModelText.mockImplementation(async (t: string | undefined) => t)
  findMatchingWorkflows.mockReturnValue([{ workflowId: "wf1", nodeId: "t1", params: {} }])
  initCaptureEventTrigger()
})

afterEach(() => disposeCaptureEventTrigger())

it("does not read the captured item when nothing subscribed the kind", async () => {
  // Reading a captured item is reading the user's clipboard, so the cheap
  // check comes first.
  findMatchingWorkflows.mockReturnValue([])
  await _injectCapturePersistedForTest(EVENT)
  expect(getCapturedItem).not.toHaveBeenCalled()
})

it("reduces the source url to its host before the gate ever sees it", async () => {
  await _injectCapturePersistedForTest(EVENT)
  expect(gateModelText).toHaveBeenCalledWith("example.com", 253)
  expect(gateModelText).not.toHaveBeenCalledWith(
    expect.stringContaining("utm=1"),
    expect.anything()
  )
})

it("omits a url it cannot parse rather than passing the raw string on", async () => {
  getCapturedItem.mockResolvedValue({
    id: "cap1",
    kind: "url",
    capturedAt: 1000,
    sourceUrl: "not a url at all",
  })
  await _injectCapturePersistedForTest(EVENT)
  const payload = (dispatchTrigger.mock.calls[0][0] as { payload: Record<string, unknown> }).payload
  expect(payload.urlHost).toBeUndefined()
  expect(JSON.stringify(payload)).not.toContain("not a url")
})

it("does nothing for a captured item that is already gone", async () => {
  getCapturedItem.mockResolvedValue(undefined)
  await _injectCapturePersistedForTest(EVENT)
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("does nothing once disposed", async () => {
  disposeCaptureEventTrigger()
  await _injectCapturePersistedForTest(EVENT)
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("swallows a read failure rather than breaking the bus", async () => {
  getCapturedItem.mockRejectedValue(new Error("db is gone"))
  await expect(_injectCapturePersistedForTest(EVENT)).resolves.toBeUndefined()
})

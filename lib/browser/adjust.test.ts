const evaluateMock = jest.fn()
jest.mock("./client", () => ({
  browserClient: { embedEvaluate: (...args: unknown[]) => evaluateMock(...args) },
}))

import {
  acceptBrowserAdjustment,
  previewBrowserAdjustment,
  revertBrowserAdjustment,
  serializeBrowserAdjustmentFeedback,
  type BrowserAdjustDriver,
} from "./adjust"

const envelope = (value: unknown) => ({ ok: true, value: JSON.stringify(value) })

beforeEach(() =>
  evaluateMock.mockReset().mockResolvedValue(envelope({ ok: true, error: null, reverted: true }))
)

it("previews through the overlay's __cogniaAdjust with JSON arguments", async () => {
  const changes = [{ property: "color", cssProperty: "color", before: "black", after: "red" }]
  evaluateMock.mockResolvedValueOnce(envelope({ ok: true, error: null, changes }))
  await expect(
    previewBrowserAdjustment({
      previewId: "preview-1",
      selector: "#title",
      draft: { color: "red", text: "Hello" },
    })
  ).resolves.toEqual(changes)
  const expression = evaluateMock.mock.calls[0][0] as string
  expect(expression).toMatch(/^window\.__cogniaAdjust\("preview", /)
  // The selector travels as data inside a JSON string, never as code.
  expect(expression).toContain(
    JSON.stringify(
      JSON.stringify({
        previewId: "preview-1",
        selector: "#title",
        draft: { color: "red", text: "Hello" },
      })
    )
  )
})

it("reverts temporary styles on cancel and accept", async () => {
  await revertBrowserAdjustment("preview-1")
  const feedback = await acceptBrowserAdjustment({
    previewId: "preview-1",
    sessionId: "session-1",
    browserSessionId: "browser-1",
    pageUrl: "http://localhost:3000",
    selector: "#title",
    changes: [{ property: "text", before: "Before", after: "After" }],
    now: 10,
  })
  expect(evaluateMock).toHaveBeenCalledTimes(2)
  expect(evaluateMock.mock.calls[1][0]).toMatch(/^window\.__cogniaAdjust\("revert", /)
  expect(feedback).toEqual(expect.objectContaining({ previewState: "accepted", updatedAt: 10 }))
  expect(serializeBrowserAdjustmentFeedback(feedback)).toContain("<browser_adjustment_feedback>")
})

it("surfaces the page's error and a failed evaluate", async () => {
  evaluateMock.mockResolvedValueOnce(
    envelope({ ok: false, error: "selected element is no longer available" })
  )
  await expect(
    previewBrowserAdjustment({ previewId: "p", selector: "#gone", draft: {} })
  ).rejects.toThrow("selected element is no longer available")
  evaluateMock.mockResolvedValueOnce({ ok: false, error: "lease moved" })
  await expect(revertBrowserAdjustment("p")).rejects.toThrow("lease moved")
  evaluateMock.mockResolvedValueOnce({ ok: true, value: "{not json" })
  await expect(revertBrowserAdjustment("p")).rejects.toThrow("Browser adjustment revert failed")
})

it("runs on another engine through an injected driver", async () => {
  const run = jest.fn(async (action: string) =>
    JSON.stringify(
      action === "preview"
        ? { ok: true, error: null, changes: [{ property: "text", before: "a", after: "b" }] }
        : { ok: true, error: null, reverted: true }
    )
  )
  const driver: BrowserAdjustDriver = { run }
  await expect(
    previewBrowserAdjustment({ previewId: "p", selector: "#x", draft: { text: "b" } }, driver)
  ).resolves.toHaveLength(1)
  await acceptBrowserAdjustment(
    {
      previewId: "p",
      sessionId: "s",
      browserSessionId: "b",
      pageUrl: "https://example.com/",
      selector: "#x",
      changes: [],
      now: 1,
    },
    driver
  )
  expect(run.mock.calls.map(([action]) => action)).toEqual(["preview", "revert"])
  expect(evaluateMock).not.toHaveBeenCalled()
})

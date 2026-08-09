const evaluateMock = jest.fn()
jest.mock("./client", () => ({
  browserClient: { embedEvaluate: (...args: unknown[]) => evaluateMock(...args) },
}))

import {
  acceptBrowserAdjustment,
  previewBrowserAdjustment,
  revertBrowserAdjustment,
  serializeBrowserAdjustmentFeedback,
} from "./adjust"

beforeEach(() => evaluateMock.mockReset().mockResolvedValue({ ok: true, value: true }))

it("previews only the controlled font/text/spacing/color properties", async () => {
  const changes = [{ property: "color", cssProperty: "color", before: "black", after: "red" }]
  evaluateMock.mockResolvedValueOnce({ ok: true, value: { before: changes, after: changes } })
  await expect(
    previewBrowserAdjustment({
      previewId: "preview-1",
      selector: "#title",
      draft: { color: "red", text: "Hello" },
    })
  ).resolves.toEqual(changes)
  expect(evaluateMock.mock.calls[0][0]).toContain("querySelector")
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
  expect(feedback).toEqual(expect.objectContaining({ previewState: "accepted", updatedAt: 10 }))
  expect(serializeBrowserAdjustmentFeedback(feedback)).toContain("<browser_adjustment_feedback>")
})

/** @jest-environment jsdom */

import { COMPOSER_APPEND_EVENT, type ComposerAppendDetail } from "./composer-append"
import { joinWithdrawnText, restoreWithdrawnToComposer } from "./restore-withdrawn"

const getDraftMock = jest.fn()
const setDraftMock = jest.fn()
jest.mock("@/lib/db/chat-drafts", () => ({
  getDraft: (...args: unknown[]) => getDraftMock(...args),
  setDraft: (...args: unknown[]) => setDraftMock(...args),
}))

const withdrawn = [
  { actionId: "a1", messageId: "m1", text: " first ", attachmentNames: ["shot.png"] },
  { actionId: "a2", messageId: "m2", text: "", attachmentNames: ["doc.pdf"] },
  { actionId: "a3", messageId: "m3", text: "second", attachmentNames: [] },
]

function listen(claim: boolean) {
  const seen: ComposerAppendDetail[] = []
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerAppendDetail>).detail
    seen.push({ ...detail })
    if (claim) detail.claimed = true
  }
  window.addEventListener(COMPOSER_APPEND_EVENT, listener)
  return { seen, stop: () => window.removeEventListener(COMPOSER_APPEND_EVENT, listener) }
}

beforeEach(() => {
  getDraftMock.mockReset().mockResolvedValue(null)
  setDraftMock.mockReset().mockResolvedValue(undefined)
})

it("joins the texts oldest first, skipping attachment-only sends", () => {
  expect(joinWithdrawnText(withdrawn)).toBe("first\n\nsecond")
})

it("hands everything to the conversation's composer in one append", async () => {
  const { seen, stop } = listen(true)
  await restoreWithdrawnToComposer("s1", withdrawn)
  stop()
  expect(seen).toEqual([
    expect.objectContaining({
      sessionId: "s1",
      text: "first\n\nsecond",
      missing: ["shot.png", "doc.pdf"],
    }),
  ])
  expect(setDraftMock).not.toHaveBeenCalled()
})

it("puts the text on the stored draft when no composer took it", async () => {
  getDraftMock.mockResolvedValue({ text: "already typed", attachments: [{ name: "a.png" }] })
  const { stop } = listen(false)
  await restoreWithdrawnToComposer("s1", withdrawn)
  stop()
  expect(setDraftMock).toHaveBeenCalledWith("s1", "already typed\n\nfirst\n\nsecond", [
    { name: "a.png" },
  ])
})

it("does nothing for an empty hand-back", async () => {
  const { seen, stop } = listen(true)
  await restoreWithdrawnToComposer("s1", [])
  stop()
  expect(seen).toEqual([])
  expect(getDraftMock).not.toHaveBeenCalled()
})

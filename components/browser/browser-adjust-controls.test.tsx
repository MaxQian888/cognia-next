import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const previewMock = jest.fn()
const revertMock = jest.fn()
const acceptMock = jest.fn()
jest.mock("@/lib/browser/adjust", () => ({
  previewBrowserAdjustment: (...args: unknown[]) => previewMock(...args),
  revertBrowserAdjustment: (...args: unknown[]) => revertMock(...args),
  acceptBrowserAdjustment: (...args: unknown[]) => acceptMock(...args),
}))

import { toast } from "sonner"
import { BrowserAdjustControls } from "./browser-adjust-controls"

const renderControls = (onAccept = jest.fn()) => {
  render(
    <BrowserAdjustControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000"
      selector="#title"
      onAccept={onAccept}
    />
  )
  return { onAccept, color: screen.getByLabelText("Color (for example, #2563eb)") }
}

beforeEach(() => {
  previewMock.mockReset().mockResolvedValue([{ property: "color", before: "black", after: "red" }])
  revertMock.mockReset().mockResolvedValue(undefined)
  acceptMock.mockReset().mockResolvedValue({ id: "preview", previewState: "accepted" })
  ;(toast.error as jest.Mock).mockClear()
})

it("previews, reverts, and accepts structured adjustment feedback", async () => {
  const onAccept = jest.fn()
  render(
    <BrowserAdjustControls
      sessionId="session-1"
      browserSessionId="browser-1"
      pageUrl="http://localhost:3000"
      selector="#title"
      onAccept={onAccept}
    />
  )
  fireEvent.change(screen.getByLabelText("Color (for example, #2563eb)"), {
    target: { value: "red" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(previewMock).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "Accept feedback" }))
  await waitFor(() =>
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: "preview" }))
  )
})

// Each of these drives an `embedEvaluate` round-trip that can reject; without a
// catch the rejection was an invisible unhandled promise and the button looked
// broken.
it("reports a failed preview instead of doing nothing", async () => {
  previewMock.mockRejectedValueOnce(new Error("selected element is no longer available"))
  const { color } = renderControls()
  fireEvent.change(color, { target: { value: "red" } })
  fireEvent.click(screen.getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  // The button unlocks again rather than staying stuck in its busy state.
  expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled()
})

it("reports a failed accept", async () => {
  acceptMock.mockRejectedValueOnce(new Error("boom"))
  const { onAccept, color } = renderControls()
  fireEvent.change(color, { target: { value: "red" } })
  fireEvent.click(screen.getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(previewMock).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "Accept feedback" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(onAccept).not.toHaveBeenCalled()
})

it("re-disables Preview when the only field is cleared again", () => {
  const { color } = renderControls()
  expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled()
  fireEvent.change(color, { target: { value: "red" } })
  expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled()
  fireEvent.change(color, { target: { value: "   " } })
  expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled()
})

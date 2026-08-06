import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const previewMock = jest.fn()
const revertMock = jest.fn()
const acceptMock = jest.fn()
jest.mock("@/lib/browser/adjust", () => ({
  previewBrowserAdjustment: (...args: unknown[]) => previewMock(...args),
  revertBrowserAdjustment: (...args: unknown[]) => revertMock(...args),
  acceptBrowserAdjustment: (...args: unknown[]) => acceptMock(...args),
}))

import { BrowserAdjustControls } from "./browser-adjust-controls"

beforeEach(() => {
  previewMock.mockReset().mockResolvedValue([{ property: "color", before: "black", after: "red" }])
  revertMock.mockReset().mockResolvedValue(undefined)
  acceptMock.mockReset().mockResolvedValue({ id: "preview", previewState: "accepted" })
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

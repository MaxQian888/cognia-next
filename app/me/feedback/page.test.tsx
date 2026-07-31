/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  snapshotSyncStates: () => ({}),
}))

const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastMock.success(m),
    error: (m: string) => toastMock.error(m),
  },
}))

import Page from "./page"

describe("MobileFeedbackPage", () => {
  beforeEach(() => {
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  it("renders the open-issue row pointing at GitHub", () => {
    render(<Page />)
    expect(screen.getByTestId("feedback-row-open-issue")).toHaveAttribute(
      "href",
      "https://github.com/anthropics/claude-code/issues/new"
    )
  })

  it("clicking copy writes diagnostics to the clipboard", async () => {
    const writeText = jest.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<Page />)
    fireEvent.click(screen.getByTestId("feedback-row-copy"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Cognia ")))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it("falls back to error toast when clipboard is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    })
    render(<Page />)
    fireEvent.click(screen.getByTestId("feedback-row-copy"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("renders the device-info shortcut", () => {
    render(<Page />)
    expect(screen.getByTestId("feedback-row-device-info")).toHaveAttribute(
      "href",
      "/me/device-info"
    )
  })
})

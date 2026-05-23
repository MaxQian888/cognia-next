/**
 * Tests for the workspace error panel (collapsible bottom drawer).
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const setError = jest.fn()
const storeState: { errors: Record<string, string | null>; setError: typeof setError } = {
  errors: {},
  setError,
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { A2UIErrorPanel } from "./a2ui-error-panel"

function renderPanel(surfaceId = "sx") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <A2UIErrorPanel />
      </A2UIWorkspaceProvider>
    </NextIntlClientProvider>
  )
}

describe("A2UIErrorPanel", () => {
  beforeEach(() => {
    setError.mockReset()
    storeState.errors = {}
  })

  it("renders nothing when no error is set", () => {
    const { container } = renderPanel()
    expect(container.firstChild).toBeNull()
  })

  it("renders the error message when one is present", () => {
    storeState.errors = { sx: "Render failed: foo is undefined" }
    renderPanel()
    expect(screen.getByText(/render failed: foo is undefined/i)).toBeInTheDocument()
  })

  it("clears the error when the close button is clicked", () => {
    storeState.errors = { sx: "boom" }
    renderPanel()
    const buttons = screen.getAllByRole("button")
    // The last button is the X close button.
    fireEvent.click(buttons[buttons.length - 1])
    expect(setError).toHaveBeenCalledWith("sx", null)
  })
})

/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ResponsiveFormDialog } from "./responsive-form-dialog"

const useIsMobileMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => useIsMobileMock(),
}))

beforeEach(() => {
  useIsMobileMock.mockReset().mockReturnValue(false)
})

function renderForm(overrides: Partial<React.ComponentProps<typeof ResponsiveFormDialog>> = {}) {
  const onOpenChange = jest.fn()
  render(
    <ResponsiveFormDialog
      open
      onOpenChange={onOpenChange}
      title="Edit thing"
      description="Change the thing"
      footer={<button type="button">Save</button>}
      testid="thing-editor"
      {...overrides}
    >
      <label>
        Name
        <input />
      </label>
    </ResponsiveFormDialog>
  )
  return { onOpenChange }
}

describe("ResponsiveFormDialog", () => {
  it("renders a centred Dialog with title, description, body and footer on desktop", () => {
    renderForm()
    expect(screen.getByTestId("thing-editor-dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("thing-editor-drawer")).toBeNull()
    expect(screen.getByRole("dialog", { name: "Edit thing" })).toBeInTheDocument()
    expect(screen.getByText("Change the thing")).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
    expect(screen.getByTestId("thing-editor-footer")).toContainElement(
      screen.getByRole("button", { name: "Save" })
    )
  })

  it("keeps the body as the one scroll region in dynamic-viewport units", () => {
    renderForm({ contentClassName: "sm:max-w-[640px]" })
    expect(screen.getByTestId("thing-editor-body")).toHaveClass("overflow-y-auto", "min-h-0")
    const content = screen.getByTestId("thing-editor-dialog")
    expect(content.className).toContain("max-h-[85dvh]")
    expect(content).toHaveClass("sm:max-w-[640px]")
  })

  it("renders a bottom Drawer with a sticky footer on mobile", () => {
    useIsMobileMock.mockReturnValue(true)
    renderForm()
    const drawer = screen.getByTestId("thing-editor-drawer")
    expect(drawer).toBeInTheDocument()
    expect(screen.queryByTestId("thing-editor-dialog")).toBeNull()
    // Keyboard-safe height: dvh shrinks with the on-screen keyboard.
    expect(drawer.className).toContain("100dvh")
    expect(screen.getByText("Edit thing")).toBeInTheDocument()
    expect(screen.getByText("Change the thing")).toBeInTheDocument()
    expect(screen.getByTestId("thing-editor-body")).toHaveClass("overflow-y-auto")
    expect(screen.getByTestId("thing-editor-footer")).toHaveClass("sticky", "bottom-0")
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
  })

  it("omits the description and footer when not provided", () => {
    renderForm({ description: undefined, footer: undefined })
    expect(screen.queryByText("Change the thing")).toBeNull()
    expect(screen.queryByTestId("thing-editor-footer")).toBeNull()
  })

  it("renders nothing while closed", () => {
    renderForm({ open: false })
    expect(screen.queryByText("Edit thing")).toBeNull()
  })

  it("reports a dismissal through onOpenChange", async () => {
    const { onOpenChange } = renderForm()
    await userEvent.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

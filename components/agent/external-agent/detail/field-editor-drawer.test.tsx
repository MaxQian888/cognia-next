/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import common from "@/i18n/messages/en/common.json"
import externalAgent from "@/i18n/messages/en/externalAgent.json"
import { FieldEditorDrawer, type FieldEditorDrawerProps } from "./field-editor-drawer"

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
const useIsMobileMock = jest.fn(() => false)
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => useIsMobileMock() }))

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ common, externalAgent }} timeZone="UTC">
    {children}
  </NextIntlClientProvider>
)

function renderEditor(props: Partial<FieldEditorDrawerProps> = {}) {
  const onSave = jest.fn().mockResolvedValue(true)
  const onOpenChange = jest.fn()
  render(
    <FieldEditorDrawer
      open
      title="Name"
      description="Edit this item"
      testid="field"
      onOpenChange={onOpenChange}
      onSave={onSave}
      {...props}
    >
      <label>
        Name
        <input />
      </label>
      <label>
        Description
        <textarea />
      </label>
    </FieldEditorDrawer>,
    { wrapper }
  )
  return { onSave, onOpenChange }
}

beforeEach(() => useIsMobileMock.mockReturnValue(false))

describe("FieldEditorDrawer", () => {
  it("saves and closes only when the save succeeds", async () => {
    const { onSave, onOpenChange } = renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("stays open after inline validation rejects a save", async () => {
    const onSave = jest.fn().mockResolvedValue(false)
    const { onOpenChange } = renderEditor({ onSave })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("shows pending state and prevents duplicate saves or dismissal during a save", async () => {
    let complete!: (value: boolean) => void
    const onSave = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve
        })
    )
    const { onOpenChange } = renderEditor({ onSave })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "Description" })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => complete(true))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("submits Enter in a single-line input, but preserves textarea and composition input", async () => {
    const { onSave } = renderEditor()
    fireEvent.keyDown(screen.getByLabelText("Description"), { key: "Enter" })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), {
      key: "Enter",
      isComposing: true,
    })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  })

  it("honors saveDisabled for both clicks and Enter", () => {
    const { onSave } = renderEditor({ saveDisabled: true })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows rejected saves inline and permits another attempt", async () => {
    const onSave = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true)
    const { onOpenChange } = renderEditor({ onSave })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(externalAgent.setConfigOptionFailed)
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("cancels without saving and renders the mobile drawer shell", () => {
    useIsMobileMock.mockReturnValue(true)
    const { onSave, onOpenChange } = renderEditor()
    expect(screen.getByTestId("field-drawer")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("min-h-11")
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("min-h-11")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
  })
})

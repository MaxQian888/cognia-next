/**
 * Coverage for the UnredactDialog component — the Drafts → Accept restore
 * picker. We exercise the open / toggle / restore-all / keep-all /
 * per-row toggle / confirm flows.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { UnredactDialog } from "./unredact-dialog"
import type { UnredactPlaceholder } from "@/lib/twin/distill/unredact-draft"

const PLACEHOLDERS: UnredactPlaceholder[] = [
  { placeholder: "<EMAIL_001>", original: "alice@example.com", kind: "EMAIL", keep: true },
  { placeholder: "<PHONE_002>", original: "+1 415 555 0100", kind: "PHONE", keep: true },
  { placeholder: "<API_KEY_003>", original: "sk-xyz", kind: "API_KEY", keep: true },
]

describe("UnredactDialog", () => {
  it("does not render content while closed", () => {
    render(
      <UnredactDialog
        open={false}
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.queryByTestId("twin-unredact-dialog")).toBeNull()
  })

  it("renders one row per placeholder with a kind badge + original", () => {
    render(
      <UnredactDialog
        open
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={jest.fn()}
      />
    )
    expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    expect(screen.getByText("+1 415 555 0100")).toBeInTheDocument()
    expect(screen.getByText("sk-xyz")).toBeInTheDocument()
    expect(screen.getByText("EMAIL")).toBeInTheDocument()
    expect(screen.getByText("API_KEY")).toBeInTheDocument()
  })

  it("emits onConfirm with every placeholder restored by default", async () => {
    const onConfirm = jest.fn()
    render(
      <UnredactDialog
        open
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={onConfirm}
      />
    )
    await userEvent.click(screen.getByTestId("twin-unredact-confirm"))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const selection = onConfirm.mock.calls[0][0] as Array<{ keep: boolean }>
    expect(selection.every((s) => s.keep)).toBe(true)
    expect(selection).toHaveLength(3)
  })

  it("toggles individual placeholders via their checkbox", async () => {
    const onConfirm = jest.fn()
    render(
      <UnredactDialog
        open
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={onConfirm}
      />
    )
    // Untick the EMAIL row.
    const checkboxes = screen.getAllByRole("checkbox")
    await userEvent.click(checkboxes[0])
    await userEvent.click(screen.getByTestId("twin-unredact-confirm"))
    const selection = onConfirm.mock.calls[0][0] as Array<{
      placeholder: string
      keep: boolean
    }>
    const email = selection.find((s) => s.placeholder === "<EMAIL_001>")
    expect(email?.keep).toBe(false)
    // The other two stay restored.
    expect(selection.filter((s) => s.keep)).toHaveLength(2)
  })

  it("'Keep all' flips every checkbox off; 'Restore all' flips them back on", async () => {
    const onConfirm = jest.fn()
    render(
      <UnredactDialog
        open
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={onConfirm}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Keep all/i }))
    await userEvent.click(screen.getByTestId("twin-unredact-confirm"))
    const firstCall = onConfirm.mock.calls[0][0] as Array<{ keep: boolean }>
    expect(firstCall.every((s) => !s.keep)).toBe(true)

    // Reset and try restore-all.
    onConfirm.mockClear()
    await userEvent.click(screen.getByRole("button", { name: /Restore all/i }))
    await userEvent.click(screen.getByTestId("twin-unredact-confirm"))
    const secondCall = onConfirm.mock.calls[0][0] as Array<{ keep: boolean }>
    expect(secondCall.every((s) => s.keep)).toBe(true)
  })

  it("shows the empty-state message when there are no placeholders", () => {
    render(<UnredactDialog open onOpenChange={jest.fn()} placeholders={[]} onConfirm={jest.fn()} />)
    expect(screen.getByText(/No placeholders to restore/i)).toBeInTheDocument()
  })

  it("hides the confirm button + cancel while busy via prop", () => {
    render(
      <UnredactDialog
        open
        onOpenChange={jest.fn()}
        placeholders={PLACEHOLDERS}
        onConfirm={jest.fn()}
        busy
      />
    )
    expect(screen.getByTestId("twin-unredact-confirm")).toBeDisabled()
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeDisabled()
  })

  it("Cancel calls onOpenChange(false)", async () => {
    const onOpenChange = jest.fn()
    render(
      <UnredactDialog
        open
        onOpenChange={onOpenChange}
        placeholders={PLACEHOLDERS}
        onConfirm={jest.fn()}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

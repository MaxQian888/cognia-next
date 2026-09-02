/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { PinPad } from "./pin-pad"
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH } from "@/lib/accounts/quick-unlock/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

function type(digits: string): void {
  for (const digit of digits) {
    fireEvent.click(screen.getByTestId(`pin-key-${digit}`))
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("PinPad", () => {
  it("commits a PIN of at least the minimum length", () => {
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} />)

    type("428193")
    fireEvent.click(screen.getByTestId("pin-submit"))
    expect(onSubmit).toHaveBeenCalledWith("428193")
  })

  it("refuses to submit below the minimum", () => {
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} />)
    type("4281")
    expect(screen.getByTestId("pin-submit")).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows one filled dot per digit without revealing the digits", () => {
    // A PIN is typed in public. The readout says how many, never which.
    render(<PinPad onSubmit={jest.fn()} />)
    type("4281")
    const readout = screen.getByTestId("pin-readout")
    expect(readout).toHaveAttribute("aria-label", expect.stringContaining('"count":4'))
    expect(readout.textContent).toBe("")
  })

  it("keeps at least the minimum number of dot slots visible", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    expect(screen.getByTestId("pin-readout").children).toHaveLength(MIN_PIN_LENGTH)
  })

  it("grows the readout past the minimum", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    type("42819312")
    expect(screen.getByTestId("pin-readout").children).toHaveLength(8)
  })

  it("stops accepting digits at the maximum", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    type("1".repeat(MAX_PIN_LENGTH + 3))
    expect(screen.getByTestId("pin-readout").children).toHaveLength(MAX_PIN_LENGTH)
  })

  it("removes the last digit on backspace", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    type("4281")
    fireEvent.click(screen.getByTestId("pin-backspace"))
    expect(screen.getByTestId("pin-readout")).toHaveAttribute(
      "aria-label",
      expect.stringContaining('"count":3')
    )
  })

  it("clears everything", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    type("4281")
    fireEvent.click(screen.getByTestId("pin-clear"))
    expect(screen.getByTestId("pin-readout")).toHaveAttribute(
      "aria-label",
      expect.stringContaining('"count":0')
    )
  })

  it("disables backspace and clear when nothing is entered", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    expect(screen.getByTestId("pin-backspace")).toBeDisabled()
    expect(screen.getByTestId("pin-clear")).toBeDisabled()
  })

  it("accepts digits from a physical keyboard", async () => {
    // Typing is how this gets used on a laptop, and it has to work without the
    // user first finding and focusing a particular button.
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} />)
    const pad = screen.getByTestId("pin-pad")

    for (const key of "428193") fireEvent.keyDown(pad, { key })
    fireEvent.keyDown(pad, { key: "Enter" })
    await flush()

    expect(onSubmit).toHaveBeenCalledWith("428193")
  })

  it("handles Backspace from the keyboard", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    const pad = screen.getByTestId("pin-pad")
    for (const key of "4281") fireEvent.keyDown(pad, { key })
    fireEvent.keyDown(pad, { key: "Backspace" })
    expect(screen.getByTestId("pin-readout")).toHaveAttribute(
      "aria-label",
      expect.stringContaining('"count":3')
    )
  })

  it("ignores Enter below the minimum length", async () => {
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} />)
    const pad = screen.getByTestId("pin-pad")
    for (const key of "428") fireEvent.keyDown(pad, { key })
    fireEvent.keyDown(pad, { key: "Enter" })
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("auto-commits at a known length, and hides the button", async () => {
    // Only used on the enrollment confirm step, where the length IS known.
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} autoSubmitAt={6} />)
    expect(screen.queryByTestId("pin-submit")).not.toBeInTheDocument()

    type("428193")
    await flush()
    expect(onSubmit).toHaveBeenCalledWith("428193")
  })

  it("does NOT auto-commit when the length is unknown", () => {
    // On the lock screen the enrolled length is not known, and guessing would
    // submit a partial PIN and burn an attempt.
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} />)
    type("428193")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId("pin-submit")).toBeInTheDocument()
  })

  it("clears the entry after a submit so the next attempt starts fresh", () => {
    render(<PinPad onSubmit={jest.fn()} />)
    type("428193")
    fireEvent.click(screen.getByTestId("pin-submit"))
    expect(screen.getByTestId("pin-readout")).toHaveAttribute(
      "aria-label",
      expect.stringContaining('"count":0')
    )
  })

  it("blocks every input path while disabled", async () => {
    const onSubmit = jest.fn()
    render(<PinPad onSubmit={onSubmit} disabled />)

    fireEvent.click(screen.getByTestId("pin-key-4"))
    const pad = screen.getByTestId("pin-pad")
    for (const key of "428193") fireEvent.keyDown(pad, { key })
    fireEvent.keyDown(pad, { key: "Enter" })
    await flush()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId("pin-readout")).toHaveAttribute(
      "aria-label",
      expect.stringContaining('"count":0')
    )
  })

  it("announces an error and prefers it over the hint", () => {
    render(<PinPad onSubmit={jest.fn()} error="wrong PIN" hint="2 attempts left" />)
    expect(screen.getByRole("alert")).toHaveTextContent("wrong PIN")
    expect(screen.queryByText("2 attempts left")).not.toBeInTheDocument()
  })

  it("shows the hint when there is no error", () => {
    render(<PinPad onSubmit={jest.fn()} hint="2 attempts left" />)
    expect(screen.getByText("2 attempts left")).toBeInTheDocument()
  })
})

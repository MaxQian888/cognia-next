/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { ColorTokenRow } from "./color-token-row"

describe("ColorTokenRow", () => {
  it("renders the label, swatch and hex input", () => {
    const onChange = jest.fn()
    render(<ColorTokenRow tokenKey="primary" label="Primary" value="#ff0000" onChange={onChange} />)
    expect(screen.getByLabelText("Primary swatch")).toBeInTheDocument()
    const hex = screen.getByLabelText("Primary hex") as HTMLInputElement
    expect(hex.value).toBe("#ff0000")
  })

  it("falls back to tokenKey when no label is provided", () => {
    render(<ColorTokenRow tokenKey="muted" value="#808080" onChange={() => {}} />)
    expect(screen.getByLabelText("muted swatch")).toBeInTheDocument()
  })

  it("calls onChange when the hex input changes", () => {
    const onChange = jest.fn()
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText("bg hex"), { target: { value: "#123456" } })
    expect(onChange).toHaveBeenCalledWith("#123456")
  })

  it("calls onChange when the swatch changes", () => {
    const onChange = jest.fn()
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText("bg swatch"), { target: { value: "#abcdef" } })
    expect(onChange).toHaveBeenCalledWith("#abcdef")
  })

  it("marks the hex input invalid when value is not hex", () => {
    render(<ColorTokenRow tokenKey="bg" value="not-a-color" onChange={() => {}} />)
    const hex = screen.getByLabelText("bg hex") as HTMLInputElement
    expect(hex.getAttribute("aria-invalid")).toBe("true")
  })

  it("uses a fallback swatch value when hex is invalid", () => {
    render(<ColorTokenRow tokenKey="bg" value="not-a-color" onChange={() => {}} />)
    const swatch = screen.getByLabelText("bg swatch") as HTMLInputElement
    // Native input[type=color] always reports 6-digit hex.
    expect(swatch.value).toBe("#888888")
  })

  it("renders the hint when provided", () => {
    render(<ColorTokenRow tokenKey="bg" value="#000" onChange={() => {}} hint="Background color" />)
    expect(screen.getByText("Background color")).toBeInTheDocument()
  })

  it("disables both inputs when disabled", () => {
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={() => {}} disabled />)
    expect((screen.getByLabelText("bg swatch") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText("bg hex") as HTMLInputElement).disabled).toBe(true)
  })
})

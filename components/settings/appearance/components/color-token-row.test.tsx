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
    expect(screen.getByTestId("color-token-primary-swatch")).toBeInTheDocument()
    const hex = screen.getByTestId("color-token-primary-hex") as HTMLInputElement
    expect(hex.value).toBe("#ff0000")
  })

  it("falls back to tokenKey when no label is provided", () => {
    render(<ColorTokenRow tokenKey="muted" value="#808080" onChange={() => {}} />)
    expect(screen.getByTestId("color-token-muted-swatch")).toBeInTheDocument()
  })

  it("calls onChange when the hex input changes", () => {
    const onChange = jest.fn()
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={onChange} />)
    fireEvent.change(screen.getByTestId("color-token-bg-hex"), { target: { value: "#123456" } })
    expect(onChange).toHaveBeenCalledWith("#123456")
  })

  it("calls onChange when the swatch changes", () => {
    const onChange = jest.fn()
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={onChange} />)
    fireEvent.change(screen.getByTestId("color-token-bg-swatch"), { target: { value: "#abcdef" } })
    expect(onChange).toHaveBeenCalledWith("#abcdef")
  })

  it("marks the hex input invalid when value is not hex", () => {
    render(<ColorTokenRow tokenKey="bg" value="not-a-color" onChange={() => {}} />)
    const hex = screen.getByTestId("color-token-bg-hex") as HTMLInputElement
    expect(hex.getAttribute("aria-invalid")).toBe("true")
  })

  it("uses a fallback swatch value when hex is invalid", () => {
    render(<ColorTokenRow tokenKey="bg" value="not-a-color" onChange={() => {}} />)
    const swatch = screen.getByTestId("color-token-bg-swatch") as HTMLInputElement
    // Native input[type=color] always reports 6-digit hex.
    expect(swatch.value).toBe("#888888")
  })

  it("renders the hint when provided", () => {
    render(<ColorTokenRow tokenKey="bg" value="#000" onChange={() => {}} hint="Background color" />)
    expect(screen.getByText("Background color")).toBeInTheDocument()
  })

  it("disables both inputs when disabled", () => {
    render(<ColorTokenRow tokenKey="bg" value="#000000" onChange={() => {}} disabled />)
    expect((screen.getByTestId("color-token-bg-swatch") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId("color-token-bg-hex") as HTMLInputElement).disabled).toBe(true)
  })
})

/**
 * The field used to be hex-only. Every real token default is an `oklch()`, and
 * two of them carry alpha — so opening the editor would have flagged most rows
 * `aria-invalid` with a red border the moment the defaults became visible.
 */
describe("non-hex CSS colours", () => {
  it.each([
    ["oklch(0.62 0.17 145)"],
    ["oklch(0.53 0.23 293 / 22%)"],
    ["rgb(12 34 56)"],
    ["rebeccapurple"],
  ])("accepts %s", (value) => {
    render(<ColorTokenRow tokenKey="warning" value={value} onChange={jest.fn()} />)
    const field = screen.getByTestId("color-token-warning-hex")
    expect(field).toHaveValue(value)
    expect(field).toHaveAttribute("aria-invalid", "false")
  })

  it("shows the nearest hex in the native picker while the field keeps the notation", () => {
    render(<ColorTokenRow tokenKey="warning" value="oklch(1 0 0)" onChange={jest.fn()} />)
    expect(screen.getByTestId("color-token-warning-swatch")).toHaveValue("#ffffff")
    expect(screen.getByTestId("color-token-warning-hex")).toHaveValue("oklch(1 0 0)")
  })

  it("still flags a value that is not a colour at all", () => {
    render(<ColorTokenRow tokenKey="warning" value="not-a-colour" onChange={jest.fn()} />)
    expect(screen.getByTestId("color-token-warning-hex")).toHaveAttribute("aria-invalid", "true")
    // The picker has nothing honest to show, so it stays neutral.
    expect(screen.getByTestId("color-token-warning-swatch")).toHaveValue("#888888")
  })

  it("falls back to neutral for a computed notation culori cannot resolve", () => {
    render(
      <ColorTokenRow
        tokenKey="brandWash"
        value="color-mix(in oklab, #35cedd 7%, #ffffff)"
        onChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("color-token-brandWash-swatch")).toHaveValue("#888888")
  })
})

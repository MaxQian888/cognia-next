/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { GradientBuilder, buildGradientCss } from "./gradient-builder"

describe("buildGradientCss", () => {
  it("produces a 2-stop linear gradient", () => {
    expect(buildGradientCss({ start: "#000000", end: "#ffffff", angle: 90 })).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)"
    )
  })
  it("clamps angle to 0..360", () => {
    expect(buildGradientCss({ start: "#000", end: "#fff", angle: -10 })).toMatch(/0deg/)
    expect(buildGradientCss({ start: "#000", end: "#fff", angle: 720 })).toMatch(/360deg/)
  })
})

describe("GradientBuilder", () => {
  it("disables the save button until a name is entered", () => {
    const onCreate = jest.fn()
    render(<GradientBuilder onCreate={onCreate} />)
    const saveBtn = screen.getByRole("button", { name: "save" })
    expect(saveBtn).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "MyGradient" },
    })
    expect(saveBtn).not.toBeDisabled()
  })

  it("invokes onCreate with the current css and name, then clears the name", async () => {
    const onCreate = jest.fn().mockResolvedValue(undefined)
    render(<GradientBuilder onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "Aurora 2" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0][0]).toMatch(/^linear-gradient\(\d+deg, #/)
    expect(onCreate.mock.calls[0][1]).toBe("Aurora 2")
    // Name is cleared after a successful save.
    expect((screen.getByPlaceholderText("namePlaceholder") as HTMLInputElement).value).toBe("")
  })

  it("updates the preview style when start color changes", async () => {
    render(<GradientBuilder onCreate={() => {}} />)
    const preview = screen.getByTestId("gradient-preview")
    const startSwatch = screen.getByTestId("color-token-gradient-start-swatch") as HTMLInputElement
    fireEvent.change(startSwatch, { target: { value: "#ff0000" } })
    await waitFor(() => {
      expect(preview.style.backgroundImage).toContain("#ff0000")
    })
  })

  it("uses the supplied initial stops", () => {
    render(
      <GradientBuilder
        initial={{ start: "#abcdef", end: "#fedcba", angle: 45 }}
        onCreate={() => {}}
      />
    )
    const preview = screen.getByTestId("gradient-preview")
    expect(preview.style.backgroundImage).toContain("#abcdef")
    expect(preview.style.backgroundImage).toContain("#fedcba")
    expect(preview.style.backgroundImage).toContain("45deg")
  })
})

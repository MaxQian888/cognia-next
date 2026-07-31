import React from "react"
import { render } from "@testing-library/react"
import { Text } from "ink"

import { ThemeProvider, useTheme } from "./context"
import { getBuiltinTheme } from "./builtins"

function Probe() {
  const theme = useTheme()
  return <Text color={theme.accent}>probe</Text>
}

function accentOf(container: HTMLElement): string | null {
  return container.querySelector("[data-ink='text']")?.getAttribute("data-color") ?? null
}

describe("ThemeProvider / useTheme", () => {
  it("returns the classic palette with no provider", () => {
    const { container } = render(<Probe />)
    expect(accentOf(container)).toBe(getBuiltinTheme("classic").accent)
  })

  it("provides the supplied palette to descendants", () => {
    const dark = getBuiltinTheme("dark")
    const { container } = render(
      <ThemeProvider palette={dark}>
        <Probe />
      </ThemeProvider>
    )
    expect(accentOf(container)).toBe(dark.accent)
  })
})

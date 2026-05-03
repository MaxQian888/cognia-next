/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { ThemePreview } from "./theme-preview"
import { DEFAULT_FALLBACKS } from "@/lib/appearance/vscode-theme/token-mapping"

describe("ThemePreview", () => {
  it("falls back to default tokens when colors is empty", () => {
    render(<ThemePreview colors={{}} fallback={DEFAULT_FALLBACKS.dark} />)
    const root = screen.getByTestId("theme-preview")
    expect(root.style.background).toBe("rgb(11, 18, 32)") // #0b1220
  })

  it("merges colors over the fallback", () => {
    render(
      <ThemePreview
        colors={{ background: "#ffeeaa", foreground: "#112233" }}
        fallback={DEFAULT_FALLBACKS.light}
      />
    )
    const root = screen.getByTestId("theme-preview")
    expect(root.style.background).toBe("rgb(255, 238, 170)")
    expect(root.style.color).toBe("rgb(17, 34, 51)")
  })

  it("renders default bubble texts", () => {
    render(<ThemePreview colors={{}} fallback={DEFAULT_FALLBACKS.light} />)
    expect(screen.getByText(/assistant bubble/)).toBeInTheDocument()
    expect(screen.getByText(/user bubble/)).toBeInTheDocument()
  })

  it("respects the assistantText / userText overrides", () => {
    render(
      <ThemePreview
        colors={{}}
        fallback={DEFAULT_FALLBACKS.light}
        assistantText="hi from bot"
        userText="hi from me"
      />
    )
    expect(screen.getByText("hi from bot")).toBeInTheDocument()
    expect(screen.getByText("hi from me")).toBeInTheDocument()
  })
})

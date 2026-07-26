import { render, screen } from "@testing-library/react"
import { ThemeProvider } from "./theme-provider"

const received: Array<Record<string, unknown>> = []

jest.mock("next-themes", () => ({
  ThemeProvider: ({ children, ...props }: { children: React.ReactNode }) => {
    received.push(props)
    return <div data-testid="next-themes">{children}</div>
  },
}))

describe("ThemeProvider", () => {
  beforeEach(() => {
    received.length = 0
  })

  it("renders its children", () => {
    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>
    )
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("drives the theme through a class, which is what the dark variant keys off", () => {
    // `globals.css` declares `@custom-variant dark (&:is(.dark *))`; switching
    // this to the data-attribute strategy would silently disable dark mode.
    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>
    )
    expect(received[0]).toMatchObject({ attribute: "class" })
  })

  it("defaults to following the system and keeps that option enabled", () => {
    render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>
    )
    expect(received[0]).toMatchObject({ defaultTheme: "system", enableSystem: true })
  })
})

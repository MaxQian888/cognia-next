import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { HelperHints } from "./helper-hints"

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{}}>
      {children}
    </NextIntlClientProvider>
  )
}

describe("HelperHints", () => {
  it("renders shortcut hint chips", () => {
    render(<HelperHints />, { wrapper: Wrapper })
    expect(screen.getByText(/Send/i)).toBeInTheDocument()
    expect(screen.getByText(/Drop/i)).toBeInTheDocument()
    expect(screen.getByText(/Try/i)).toBeInTheDocument()
  })

  it("hides on mobile (hidden sm:flex class)", () => {
    const { container } = render(<HelperHints />, { wrapper: Wrapper })
    const root = container.firstChild as HTMLElement
    expect(root.classList.contains("hidden")).toBe(true)
    expect(root.classList.contains("sm:flex")).toBe(true)
  })
})

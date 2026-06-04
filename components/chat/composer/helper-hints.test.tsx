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

  it("hides on small viewports AND narrow composer containers (stacked variant)", () => {
    const { container } = render(<HelperHints />, { wrapper: Wrapper })
    const root = container.firstChild as HTMLElement
    expect(root.classList.contains("hidden")).toBe(true)
    // Stacked media + container variant: the hints need BOTH a ≥sm viewport
    // (keyboard-style hints are useless on touch) and a ≥@sm composer
    // container (a narrow right-sidebar shouldn't burn rows on hint chips).
    expect(root.classList.contains("sm:@sm/composer:flex")).toBe(true)
    expect(root.classList.contains("sm:flex")).toBe(false)
  })
})

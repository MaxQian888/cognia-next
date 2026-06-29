/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileHooksPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
})

describe("MobileHooksPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileHooksPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("me-section-hooks-builtin")).toBeNull()
  })

  it("lists the product built-in hooks read-only when paired", () => {
    render(<MobileHooksPage />)
    expect(screen.getByTestId("mobile-hooks-page")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-hooks-builtin")).toBeInTheDocument()
    // Stable built-in hook ids from BUILTIN_HOOKS.
    expect(screen.getByTestId("hook-row-auto-context-loader")).toBeInTheDocument()
    expect(screen.getByTestId("hook-row-pii-safety-guard")).toBeInTheDocument()
  })

  it("surfaces the manage-on-desktop guidance and no hook editor controls", () => {
    render(<MobileHooksPage />)
    expect(screen.getByTestId("hooks-manage-note")).toBeInTheDocument()
    // No per-event editor / save controls rendered on mobile.
    expect(screen.queryByTestId("hooks-save")).toBeNull()
    expect(screen.queryByTestId("hooks-add-group")).toBeNull()
    expect(screen.queryByRole("switch")).toBeNull()
  })
})

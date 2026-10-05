/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileConfigureExternalAgentPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

const searchParams: { current: URLSearchParams; pending: Promise<void> | null } = {
  current: new URLSearchParams(),
  pending: null,
}

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/me/external-agents/new/configure",
  // Suspends like the static export does until the client has the URL.
  useSearchParams: () => {
    if (searchParams.pending) throw searchParams.pending
    return searchParams.current
  },
}))

jest.mock("@/components/mobile/external-agents/add-external-agent-form", () => ({
  AddExternalAgentForm: ({ presetId }: { presetId: string }) => (
    <div data-testid="add-external-agent-form-stub" data-preset={presetId} />
  ),
}))

beforeEach(() => {
  jest.clearAllMocks()
  searchParams.current = new URLSearchParams()
  searchParams.pending = null
  ;(useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired: true,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })
})

describe("MobileConfigureExternalAgentPage", () => {
  it("passes ?preset= to the form and names the preset in the title", async () => {
    searchParams.current = new URLSearchParams("preset=claude-code")
    render(<MobileConfigureExternalAgentPage />)
    expect(await screen.findByTestId("add-external-agent-form-stub")).toHaveAttribute(
      "data-preset",
      "claude-code"
    )
    expect(screen.getByText("Add Claude Code")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to choosing an agent" })).toBeInTheDocument()
  })

  it("uses the custom title for a custom agent", async () => {
    searchParams.current = new URLSearchParams("preset=custom")
    render(<MobileConfigureExternalAgentPage />)
    expect(await screen.findByTestId("add-external-agent-form-stub")).toHaveAttribute(
      "data-preset",
      "custom"
    )
    expect(screen.getByText("Custom agent")).toBeInTheDocument()
  })

  it("treats a missing preset as custom", async () => {
    render(<MobileConfigureExternalAgentPage />)
    expect(await screen.findByTestId("add-external-agent-form-stub")).toHaveAttribute(
      "data-preset",
      "custom"
    )
    expect(screen.getByText("Custom agent")).toBeInTheDocument()
  })

  it("hands an unknown preset to the form and falls back to the custom title", async () => {
    searchParams.current = new URLSearchParams("preset=no-such-preset")
    render(<MobileConfigureExternalAgentPage />)
    expect(await screen.findByTestId("add-external-agent-form-stub")).toHaveAttribute(
      "data-preset",
      "no-such-preset"
    )
    expect(screen.getByText("Custom agent")).toBeInTheDocument()
  })

  it("shows a skeleton of the screen, not a blank one, while the URL resolves", () => {
    searchParams.pending = new Promise(() => {})
    render(<MobileConfigureExternalAgentPage />)
    expect(screen.getByTestId("mobile-configure-external-agent-loading")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByTestId("add-external-agent-form-stub")).toBeNull()
  })
})

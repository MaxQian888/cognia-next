/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileExternalAgentsPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

// The two lists own their data and are tested next to their sources; the page
// only composes them.
jest.mock("@/components/mobile/external-agents/host-agent-list", () => ({
  HostAgentList: () => <div data-testid="host-agent-list-stub" />,
}))
jest.mock("@/components/mobile/external-agents/desktop-local-agents", () => ({
  DesktopLocalAgents: () => <div data-testid="desktop-local-agents-stub" />,
}))

const mockPaired = (paired: boolean, loading = false) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading,
    reload: jest.fn(),
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
})

describe("MobileExternalAgentsPage", () => {
  it("composes the Host list above the desktop-only agents when paired", () => {
    render(<MobileExternalAgentsPage />)
    expect(screen.getByTestId("mobile-external-agents-page")).toBeInTheDocument()
    expect(screen.getByText("External agents")).toBeInTheDocument()
    expect(screen.getByTestId("external-agents-intro")).toBeInTheDocument()

    const host = screen.getByTestId("host-agent-list-stub")
    const desktop = screen.getByTestId("desktop-local-agents-stub")
    expect(host.compareDocumentPosition(desktop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId("paired-only-placeholder")).toBeNull()
  })

  it("puts the add flow one tap away in the header", () => {
    render(<MobileExternalAgentsPage />)
    const add = screen.getByTestId("external-agents-header-add")
    expect(add).toHaveAttribute("href", "/me/external-agents/new")
    expect(screen.getByRole("link", { name: "Add an external agent" })).toBe(add)
  })

  it("shows the paired placeholder instead of the lists when unpaired", () => {
    mockPaired(false)
    render(<MobileExternalAgentsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("host-agent-list-stub")).toBeNull()
    expect(screen.queryByTestId("desktop-local-agents-stub")).toBeNull()
  })

  it("renders neither the lists nor the placeholder while pairing state loads", () => {
    mockPaired(false, true)
    render(<MobileExternalAgentsPage />)
    expect(screen.queryByTestId("paired-only-placeholder")).toBeNull()
    expect(screen.queryByTestId("host-agent-list-stub")).toBeNull()
  })
})

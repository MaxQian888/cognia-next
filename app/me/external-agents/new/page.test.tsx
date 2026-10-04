/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileAddExternalAgentPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

jest.mock("@/components/mobile/external-agents/agent-preset-picker", () => ({
  AgentPresetPicker: () => <div data-testid="agent-preset-picker-stub" />,
}))

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

describe("MobileAddExternalAgentPage", () => {
  it("renders the preset picker inside the shell", () => {
    render(<MobileAddExternalAgentPage />)
    const page = screen.getByTestId("mobile-add-external-agent-page")
    expect(page).toContainElement(screen.getByTestId("agent-preset-picker-stub"))
    expect(screen.getByText("Add external agent")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to external agents" })).toBeInTheDocument()
  })

  it("gates the picker behind pairing", () => {
    mockPaired(false)
    render(<MobileAddExternalAgentPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-preset-picker-stub")).toBeNull()
  })
})

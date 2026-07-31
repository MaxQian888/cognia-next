/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileSlashCommandsPage from "./page"
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

describe("MobileSlashCommandsPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileSlashCommandsPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("me-section-slash-commands-builtin")).toBeNull()
  })

  it("lists built-in slash commands when paired", () => {
    render(<MobileSlashCommandsPage />)
    expect(screen.getByTestId("mobile-slash-commands-page")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-slash-commands-builtin")).toBeInTheDocument()
    // `/clear` is a stable built-in command.
    expect(screen.getByTestId("slash-command-row-clear")).toBeInTheDocument()
  })

  it("surfaces the manage-on-desktop guidance and no custom-command write controls", () => {
    render(<MobileSlashCommandsPage />)
    expect(screen.getByTestId("slash-commands-manage-note")).toBeInTheDocument()
    // No "new command" / editor controls rendered on mobile.
    expect(screen.queryByTestId("slash-commands-new")).toBeNull()
    expect(screen.queryByRole("button", { name: /new|create|edit|delete/i })).toBeNull()
  })
})

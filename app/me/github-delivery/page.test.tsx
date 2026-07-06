/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileGithubDeliveryPage from "./page"
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

describe("MobileGithubDeliveryPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileGithubDeliveryPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("me-section-github-delivery-policy")).toBeNull()
  })

  it("renders the read-only default policy reference when paired", () => {
    render(<MobileGithubDeliveryPage />)
    expect(screen.getByTestId("me-section-github-delivery-policy")).toBeInTheDocument()
    expect(screen.getByTestId("gh-policy-green-ci")).toBeInTheDocument()
    expect(screen.getByTestId("gh-policy-human-approval")).toBeInTheDocument()
    expect(screen.getByTestId("gh-policy-max-merges")).toBeInTheDocument()
  })

  it("surfaces the manage-on-desktop guidance and renders no repo/credential write controls", () => {
    render(<MobileGithubDeliveryPage />)
    expect(screen.getByTestId("github-delivery-manage-note")).toBeInTheDocument()
    // No tabs / repo auth / credential wizard rendered on mobile.
    expect(screen.queryByTestId("repos-tab")).toBeNull()
    expect(screen.queryByTestId("credentials-tab")).toBeNull()
    expect(screen.queryByRole("button", { name: /connect|authenticate/i })).toBeNull()
  })
})

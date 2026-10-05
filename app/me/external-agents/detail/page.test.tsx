/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import MobileExternalAgentDetailPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

const searchParams: { current: URLSearchParams; pending: Promise<void> | null } = {
  current: new URLSearchParams(),
  pending: null,
}

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/me/external-agents/detail",
  // Suspends like the static export does until the client has the URL.
  useSearchParams: () => {
    if (searchParams.pending) throw searchParams.pending
    return searchParams.current
  },
}))

// The detail screen owns its data and is tested next to its source.
jest.mock("@/components/mobile/external-agents/host-agent-detail", () => ({
  HostAgentDetail: ({ configId }: { configId: string }) => (
    <div data-testid="host-agent-detail-stub" data-config-id={configId} />
  ),
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
  searchParams.current = new URLSearchParams()
  searchParams.pending = null
  mockPaired(true)
})

describe("MobileExternalAgentDetailPage", () => {
  it("hands ?id= to the detail screen under a page that returns to the list", async () => {
    searchParams.current = new URLSearchParams("id=eac_1")
    render(<MobileExternalAgentDetailPage />)
    expect(await screen.findByTestId("host-agent-detail-stub")).toHaveAttribute(
      "data-config-id",
      "eac_1"
    )
    expect(screen.getByText("Agent details")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to external agents" })).toBeInTheDocument()
  })

  it("passes an empty id through, for the screen to say the agent is gone", async () => {
    render(<MobileExternalAgentDetailPage />)
    expect(await screen.findByTestId("host-agent-detail-stub")).toHaveAttribute(
      "data-config-id",
      ""
    )
  })

  it("shows a skeleton of the screen while the URL resolves", () => {
    searchParams.pending = new Promise(() => {})
    render(<MobileExternalAgentDetailPage />)
    expect(screen.getByTestId("mobile-external-agent-detail-loading")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByTestId("host-agent-detail-stub")).toBeNull()
  })

  it("asks to pair instead of rendering the screen when unpaired", () => {
    mockPaired(false)
    searchParams.current = new URLSearchParams("id=eac_1")
    render(<MobileExternalAgentDetailPage />)
    expect(screen.queryByTestId("host-agent-detail-stub")).toBeNull()
  })
})

/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { PairedOnly } from "./paired-only"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

jest.mock("@/hooks/companion/use-companion-config")

const mockUseCompanionConfig = useCompanionConfig as jest.MockedFunction<
  typeof useCompanionConfig
>

function mockConfig(partial: Partial<ReturnType<typeof useCompanionConfig>>) {
  mockUseCompanionConfig.mockReturnValue({
    config: null,
    paired: false,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
    ...partial,
  })
}

describe("<PairedOnly />", () => {
  afterEach(() => jest.clearAllMocks())

  it("renders children when paired", () => {
    mockConfig({ paired: true })
    render(
      <PairedOnly>
        <div data-testid="agent-panel">panel</div>
      </PairedOnly>
    )
    expect(screen.getByTestId("agent-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("paired-only-placeholder")).toBeNull()
  })

  it("renders the placeholder (not children) when unpaired", () => {
    mockConfig({ paired: false })
    render(
      <PairedOnly>
        <div data-testid="agent-panel">panel</div>
      </PairedOnly>
    )
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-panel")).toBeNull()
  })

  it("renders nothing while the pairing state is still loading", () => {
    mockConfig({ paired: false, loading: true })
    const { container } = render(
      <PairedOnly>
        <div data-testid="agent-panel">panel</div>
      </PairedOnly>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("honors a custom placeholder testid", () => {
    mockConfig({ paired: false })
    render(
      <PairedOnly testid="agent-paired-gate">
        <div>panel</div>
      </PairedOnly>
    )
    expect(screen.getByTestId("agent-paired-gate")).toBeInTheDocument()
  })
})

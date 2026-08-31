import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: jest.fn(() => "desktop") }))

import { useHostProfile } from "@/hooks/use-host-profile"
import { DocsProviderNotice, useDocsProviderReach } from "./docs-provider-notice"

const hostProfileMock = useHostProfile as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  hostProfileMock.mockReturnValue("desktop")
})

describe("DocsProviderNotice", () => {
  it("renders nothing when reading is possible", () => {
    const { container } = render(<DocsProviderNotice reach={{ available: true }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for an unavailable reach with no block to explain", () => {
    // The composer holds this state while no namespace is active. There is no
    // sentence to show, and inventing one would flash a warning at a user who
    // did nothing.
    const { container } = render(<DocsProviderNotice reach={{ available: false }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the cause so a test or a stylesheet can key off it", () => {
    render(<DocsProviderNotice reach={{ available: false, block: "runs-on-host" }} />)
    expect(screen.getByTestId("docs-provider-notice")).toHaveAttribute("data-cause", "runs-on-host")
  })

  it("reads out both the reason and the next step", () => {
    render(<DocsProviderNotice reach={{ available: false, block: "no-runtime" }} />)
    expect(screen.getByRole("note")).toHaveTextContent("block.no-runtime nextStep.no-runtime")
  })

  it("renders the supplied action after the text", () => {
    render(
      <DocsProviderNotice
        reach={{ available: false, block: "needs-desktop-shell" }}
        action={<button type="button">Open desktop</button>}
      />
    )
    expect(screen.getByRole("button", { name: "Open desktop" })).toBeInTheDocument()
  })
})

describe("useDocsProviderReach", () => {
  function Probe({ hosts }: { hosts: readonly ("tauri" | "browser" | "mobile")[] }) {
    const reach = useDocsProviderReach({ hosts })
    return <span data-testid="probe">{reach.block ?? "available"}</span>
  }

  it("resolves against the host profile this component renders in", () => {
    hostProfileMock.mockReturnValue("cloud-companion")
    render(<Probe hosts={["tauri"]} />)
    expect(screen.getByTestId("probe")).toHaveTextContent("runs-on-host")
  })

  it("clears once the provider covers the current host", () => {
    hostProfileMock.mockReturnValue("cloud-companion")
    render(<Probe hosts={["tauri", "browser"]} />)
    expect(screen.getByTestId("probe")).toHaveTextContent("available")
  })
})

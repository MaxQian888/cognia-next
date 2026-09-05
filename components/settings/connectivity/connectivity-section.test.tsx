import { fireEvent, render, screen } from "@testing-library/react"

import { ConnectivitySection } from "./connectivity-section"

const replace = jest.fn()
let params = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/settings/common/settings-master-detail", () => ({
  SettingsMasterDetail: ({
    nav,
    children,
  }: {
    nav: (slot: "rail" | "sheet") => React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {nav("rail")}
      {children}
    </div>
  ),
}))
jest.mock("@/components/settings/common/panel-transition", () => ({
  PanelTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("./components/connectivity-nav", () => ({
  ConnectivityNav: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => onSelect("push")}>
      nav-push
    </button>
  ),
}))
jest.mock("./panels/overview-panel", () => ({
  OverviewPanel: () => <div data-testid="overview-panel" />,
}))
jest.mock("./panels/local-host-panel", () => ({
  LocalHostPanel: () => <div data-testid="local-host-panel" />,
}))
jest.mock("./panels/cloud-relay-panel", () => ({
  CloudRelayPanel: () => <div data-testid="cloud-relay-panel" />,
}))
jest.mock("./panels/pairing-panel", () => ({
  PairingPanel: () => <div data-testid="pairing-panel" />,
}))
jest.mock("./panels/remote-hosts-panel", () => ({
  RemoteHostsPanel: () => <div data-testid="remote-hosts-panel" />,
}))
jest.mock("./panels/push-panel", () => ({ PushPanel: () => <div data-testid="push-panel" /> }))
jest.mock("./panels/sync-panel", () => ({ SyncPanel: () => <div data-testid="sync-panel" /> }))

describe("ConnectivitySection", () => {
  beforeEach(() => {
    replace.mockReset()
    params = new URLSearchParams()
  })

  it("opens on the overview and writes the chosen panel to the URL", () => {
    render(<ConnectivitySection />)
    expect(screen.getByTestId("overview-panel")).toBeInTheDocument()
    expect(screen.getByTestId("connectivity-panel-body")).toHaveAttribute("data-panel", "overview")
    fireEvent.click(screen.getByText("nav-push"))
    expect(replace).toHaveBeenCalledWith("?connectivityPanel=push", { scroll: false })
  })

  it("renders the panel named by the deep link and falls back on junk", () => {
    params = new URLSearchParams("connectivityPanel=remote-hosts")
    const { unmount } = render(<ConnectivitySection />)
    expect(screen.getByTestId("remote-hosts-panel")).toBeInTheDocument()
    unmount()
    params = new URLSearchParams("connectivityPanel=nope")
    render(<ConnectivitySection />)
    expect(screen.getByTestId("overview-panel")).toBeInTheDocument()
  })
})

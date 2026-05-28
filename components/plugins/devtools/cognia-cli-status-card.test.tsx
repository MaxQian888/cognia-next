import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { TooltipProvider } from "@/components/ui/tooltip"

const mockStatus = {
  loading: false,
  installed: false,
  version: null as string | null,
  path: null as string | null,
  detection: null,
  bridge: null as unknown,
  supported: true,
  refresh: jest.fn(),
}
jest.mock("@/hooks/plugins/use-cognia-cli-status", () => ({
  useCogniaCliStatus: () => mockStatus,
}))
jest.mock("@/lib/native/opener", () => ({
  openUrl: jest.fn(),
  openPath: jest.fn(),
}))
// The install dialog renders a Tabs tree we don't need to exercise here.
jest.mock("./cognia-cli-install-dialog", () => ({
  CogniaCliInstallDialog: () => <div data-testid="install-dialog-stub" />,
}))

import { CogniaCliStatusCard } from "./cognia-cli-status-card"

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>
        <CogniaCliStatusCard />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function resetStatus(over: Partial<typeof mockStatus>) {
  Object.assign(mockStatus, {
    loading: false,
    installed: false,
    version: null,
    path: null,
    detection: null,
    bridge: null,
    supported: true,
    refresh: jest.fn(),
    ...over,
  })
}

describe("CogniaCliStatusCard", () => {
  it("renders the missing state with an install CTA when not installed", () => {
    resetStatus({ installed: false })
    renderCard()
    expect(screen.getByTestId("cognia-cli-missing")).toBeInTheDocument()
    expect(screen.getByTestId("cognia-cli-install-cta")).toBeInTheDocument()
  })

  it("renders the installed state with version + bridge badge", () => {
    resetStatus({
      installed: true,
      version: "cognia 0.1.0",
      path: "/usr/local/bin/cognia",
      bridge: { running: true, boundPort: 1, endpointFile: "/x" },
    })
    renderCard()
    expect(screen.getByTestId("cognia-cli-installed")).toBeInTheDocument()
    expect(screen.getByText("cognia 0.1.0")).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.cliStatus.bridgeRunning)).toBeInTheDocument()
    expect(screen.getByTestId("cognia-cli-reveal")).toBeInTheDocument()
  })

  it("shows bridge-down badge when the bridge is offline", () => {
    resetStatus({
      installed: true,
      version: "cognia 0.1.0",
      bridge: { running: false, boundPort: null, endpointFile: null },
    })
    renderCard()
    expect(screen.getByText(enMessages.plugins.cliStatus.bridgeDown)).toBeInTheDocument()
  })

  it("renders the desktop-only marker on web", () => {
    resetStatus({ supported: false })
    renderCard()
    expect(screen.queryByTestId("cognia-cli-missing")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cognia-cli-installed")).not.toBeInTheDocument()
    expect(
      screen.getAllByText(enMessages.plugins.shared.installedDesktopOnly).length
    ).toBeGreaterThan(0)
  })

  it("shows the probing state while loading", () => {
    resetStatus({ loading: true })
    renderCard()
    expect(screen.getByText(enMessages.plugins.cliStatus.probing)).toBeInTheDocument()
  })
})

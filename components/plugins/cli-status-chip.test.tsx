import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
jest.mock("@/components/plugins/devtools/cognia-cli-install-dialog", () => ({
  CogniaCliInstallDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="install-dialog-open" /> : null,
}))

import { CliStatusChip } from "./cli-status-chip"

function renderChip() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TooltipProvider>
        <CliStatusChip />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function setStatus(over: Partial<typeof mockStatus>) {
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

describe("CliStatusChip", () => {
  it("renders nothing on web (unsupported)", () => {
    setStatus({ supported: false })
    const { container } = renderChip()
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing while loading", () => {
    setStatus({ loading: true })
    const { container } = renderChip()
    expect(container.firstChild).toBeNull()
  })

  it("shows the ready tone when installed + bridge running", () => {
    setStatus({
      installed: true,
      version: "cognia 0.1.0",
      bridge: { running: true, boundPort: 1, endpointFile: "/x" },
    })
    renderChip()
    expect(screen.getByTestId("cli-status-chip")).toHaveAttribute("data-tone", "ready")
  })

  it("shows the degraded tone when installed but bridge offline", () => {
    setStatus({
      installed: true,
      version: "cognia 0.1.0",
      bridge: { running: false, boundPort: null, endpointFile: null },
    })
    renderChip()
    expect(screen.getByTestId("cli-status-chip")).toHaveAttribute("data-tone", "degraded")
  })

  it("opens the install dialog when clicked while missing", async () => {
    setStatus({ installed: false })
    renderChip()
    expect(screen.getByTestId("cli-status-chip")).toHaveAttribute("data-tone", "missing")
    await userEvent.click(screen.getByTestId("cli-status-chip"))
    expect(screen.getByTestId("install-dialog-open")).toBeInTheDocument()
  })

  it("does not open the dialog when clicked while installed", async () => {
    setStatus({
      installed: true,
      version: "cognia 0.1.0",
      bridge: { running: true, boundPort: 1, endpointFile: "/x" },
    })
    renderChip()
    await userEvent.click(screen.getByTestId("cli-status-chip"))
    expect(screen.queryByTestId("install-dialog-open")).not.toBeInTheDocument()
  })
})

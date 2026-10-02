/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
const mockState = {
  status: { enabled: false, devPaths: [] as string[] },
  simulations: [] as unknown[],
  folders: [] as unknown[],
}
jest.mock("@/hooks/plugins/use-managed-ide-dev-mode", () => ({
  useManagedIdeDevMode: () => mockState,
}))
const mockUseBrokerTrace = jest.fn((_enabled: boolean) => ({ rows: [], error: null }))
jest.mock("@/hooks/plugins/use-broker-trace", () => ({
  useBrokerTrace: (enabled: boolean) => mockUseBrokerTrace(enabled),
}))
const mockEnter = jest.fn(async () => ({ enabled: true, devPaths: [] }))
const mockLeave = jest.fn(async () => ({
  status: { enabled: false, devPaths: [] },
  disabled: ["acme.dev", "beta.dev"],
  failed: [{ pluginId: "stuck", error: "busy" }],
}))
jest.mock("@/lib/plugin/ide/dev-mode-session", () => ({
  enterManagedIdeDevMode: () => mockEnter(),
  leaveManagedIdeDevMode: () => mockLeave(),
}))
const mockConfigure = jest.fn(async (include: boolean) => ({
  enabled: true,
  includePayloads: include,
}))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { configureBrokerTrace: (include: boolean) => mockConfigure(include) },
}))
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }))
jest.mock("./broker-trace-table", () => ({
  BrokerTraceTable: ({ includePayloads }: { includePayloads: boolean }) => (
    <div data-testid="trace-stub" data-include={String(includePayloads)} />
  ),
}))
jest.mock("./permission-simulation-section", () => ({
  PermissionSimulationSection: () => <div data-testid="simulation-stub" />,
}))
jest.mock("./dev-folders-section", () => ({
  DevFoldersSection: () => <div data-testid="folders-stub" />,
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import enMessages from "@/i18n/messages/en.json"
import { isTauri } from "@/lib/tauri"

import { ManagedIdeDevModeCard } from "./managed-ide-dev-mode-card"

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ManagedIdeDevModeCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockState.status = { enabled: false, devPaths: [] }
  jest.mocked(isTauri).mockReturnValue(true)
})

it("is a desktop feature", () => {
  jest.mocked(isTauri).mockReturnValue(false)
  renderCard()
  expect(screen.getByTestId("managed-ide-desktop-only")).toBeInTheDocument()
  expect(screen.getByRole("switch", { name: "Managed IDE Dev Mode" })).toBeDisabled()
})

it("says what turning it on does, and turns it on through the session", async () => {
  renderCard()
  expect(screen.getByTestId("managed-ide-off")).toBeInTheDocument()
  expect(mockUseBrokerTrace).toHaveBeenLastCalledWith(false)
  await userEvent.click(screen.getByRole("switch", { name: "Managed IDE Dev Mode" }))
  expect(mockEnter).toHaveBeenCalledTimes(1)
})

it("on, shows the trace with its payload opt-in, simulations and folders", async () => {
  mockState.status = { enabled: true, devPaths: [] }
  renderCard()
  expect(mockUseBrokerTrace).toHaveBeenLastCalledWith(true)
  expect(screen.getByTestId("trace-stub")).toHaveAttribute("data-include", "false")
  await userEvent.click(screen.getByRole("switch", { name: "Keep payload values" }))
  expect(mockConfigure).toHaveBeenCalledWith(true)
  await waitFor(() =>
    expect(screen.getByTestId("trace-stub")).toHaveAttribute("data-include", "true")
  )
  expect(screen.getByRole("tab", { name: "Permissions" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "Plugin folders" })).toBeInTheDocument()
})

it("turning it off reports the plugins it disabled and any it could not", async () => {
  mockState.status = { enabled: true, devPaths: [] }
  renderCard()
  await userEvent.click(screen.getByRole("switch", { name: "Managed IDE Dev Mode" }))
  await waitFor(() => expect(mockLeave).toHaveBeenCalledTimes(1))
  expect(toast.info).toHaveBeenCalledWith(
    "Disabled 2 plugins that were trusted only for this Dev Mode session"
  )
  expect(toast.error).toHaveBeenCalledWith("Could not disable stuck: busy")
})

it("reports a switch the host refused", async () => {
  mockEnter.mockRejectedValueOnce(new Error("host down"))
  renderCard()
  await userEvent.click(screen.getByRole("switch", { name: "Managed IDE Dev Mode" }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Could not turn on Dev Mode: host down")
  )
})

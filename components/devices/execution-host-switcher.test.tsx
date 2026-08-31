/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

let anyActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(anyActive),
}))

import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { ExecutionHostSwitcher, StatusBarExecutionHost, hostTone } from "./execution-host-switcher"

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "h1",
    label: "Dev box",
    credentialRef: "ref",
    addedAt: 1,
    connectionState: "ready",
    config: { baseUrl: "https://box.example:27890", serverVersion: "1.0.0" },
    ...overrides,
  } as RemoteHost
}

const initial = useRemoteHostStore.getState()
const activate = jest.fn()
const deactivate = jest.fn()

function seed(hosts: RemoteHost[], activeHostId: string | null) {
  useRemoteHostStore.setState(
    { ...initial, hosts, activeHostId, activateHost: activate, deactivate },
    true
  )
}

beforeEach(() => {
  anyActive = false
  activate.mockClear()
  deactivate.mockClear()
  seed([], null)
})

afterAll(() => useRemoteHostStore.setState(initial, true))

/**
 * The five connection states must not collapse into connected/not-connected.
 * `degraded` (answered, failed its capability probe), `versionMismatch` (needs
 * an upgrade before it accepts writes) and `revoked` (threw this device out)
 * each imply a different next step.
 */
it("keeps every connection state on its own tone", () => {
  expect(hostTone(null)).toBe("neutral")
  expect(hostTone(host({ connectionState: "ready" }))).toBe("success")
  expect(hostTone(host({ connectionState: "connecting" }))).toBe("info")
  expect(hostTone(host({ connectionState: "degraded" }))).toBe("warning")
  expect(hostTone(host({ connectionState: "versionMismatch" }))).toBe("warning")
  expect(hostTone(host({ connectionState: "revoked" }))).toBe("danger")
  expect(hostTone(host({ connectionState: "disconnected" }))).toBe("neutral")
})

it("names the active host on the trigger and this machine when local", () => {
  seed([host()], "h1")
  const { rerender } = render(<ExecutionHostSwitcher />)
  expect(screen.getByTestId("execution-host-chip")).toHaveTextContent("Dev box")

  act(() => seed([host()], null))
  rerender(<ExecutionHostSwitcher />)
  expect(screen.getByTestId("execution-host-chip")).toHaveTextContent("devices.executionHost.local")
})

it("switches straight away when nothing is running", async () => {
  seed([host()], null)
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-h1"))
  expect(activate).toHaveBeenCalledWith("h1")
})

/**
 * Repointing the transport under a live turn strands it on the machine it
 * started on, with no error and a conversation that never finishes.
 */
it("asks first when a turn is in flight", async () => {
  anyActive = true
  seed([host()], null)
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-h1"))

  expect(activate).not.toHaveBeenCalled()
  await userEvent.click(await screen.findByTestId("execution-host-confirm"))
  expect(activate).toHaveBeenCalledWith("h1")
})

it("returns to local execution through the same guard", async () => {
  seed([host()], "h1")
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-local"))
  expect(deactivate).toHaveBeenCalled()
})

/**
 * `CHROME_BUDGET.statusBar` is finite, and a permanent "This machine" chip on
 * a shell that has never seen a remote host is width with no information.
 */
it("renders no status-bar segment until there is a host to switch to", () => {
  const { container, rerender } = render(<StatusBarExecutionHost />)
  expect(container).toBeEmptyDOMElement()

  act(() => seed([host()], null))
  rerender(<StatusBarExecutionHost />)
  expect(screen.getByTestId("status-execution-host")).toBeInTheDocument()
})

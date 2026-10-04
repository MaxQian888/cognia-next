/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { RemoteHostsPanel } from "./remote-hosts-panel"

let mockRunActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(mockRunActive),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.count !== undefined ? `${key}:${String(values.count)}` : key,
}))
let mockScanAvailable = false
jest.mock("@/components/connectivity/pair/add-host-form", () => ({
  AddHostForm: () => <div data-testid="add-host-form" />,
  useScanAvailable: () => mockScanAvailable,
}))
jest.mock("@/components/settings/connectivity/github-runner-panel", () => ({
  GitHubRunnerPanel: () => <div data-testid="github-runner-panel" />,
}))
jest.mock("@/components/devices/device-console-link", () => ({
  DeviceConsoleLink: ({ deviceRef }: { deviceRef?: string }) => (
    <div data-testid="device-console-link-hosts" data-ref={deviceRef ?? ""} />
  ),
}))
jest.mock("@/lib/devices/build-device-rows", () => ({
  remoteHostRef: (h: { id: string }) => `ref:${h.id}`,
}))

// The real store with stubbed actions: the panel's verbs run through the real
// `useExecutionHostSwitch`, which reads the registry at request time.
const initialStore = useRemoteHostStore.getState()
const activateHost = jest.fn()
const deactivate = jest.fn()
const removeHost = jest.fn()
const updateHostLabel = jest.fn()

function host(
  id: string,
  label: string,
  connectionState: RemoteHost["connectionState"] = "ready",
  extra: Partial<RemoteHost> = {}
): RemoteHost {
  return {
    id,
    label,
    connectionState,
    credentialRef: `ref:${id}`,
    addedAt: 1,
    config: { baseUrl: `https://${id}:27890` },
    ...extra,
  } as RemoteHost
}

function seed(hosts: RemoteHost[], activeHostId: string | null = "h1") {
  useRemoteHostStore.setState(
    { ...initialStore, hosts, activeHostId, activateHost, deactivate, removeHost, updateHostLabel },
    true
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRunActive = false
  mockScanAvailable = false
  seed([])
})

afterAll(() => useRemoteHostStore.setState(initialStore, true))

describe("RemoteHostsPanel", () => {
  it("shows the empty state and opens the add form when nothing is registered", () => {
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-hosts-empty")).toBeInTheDocument()
    expect(screen.getByTestId("add-host-form")).toBeInTheDocument()
    expect(screen.getByTestId("github-runner-panel")).toBeInTheDocument()
  })

  it("points the console link at the active host", () => {
    seed([host("h1", "active box"), host("h2", "spare", "disconnected")])
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-host-active")).toBeInTheDocument()
    expect(screen.getByTestId("device-console-link-hosts")).toHaveAttribute("data-ref", "ref:h1")
  })

  /**
   * The device console's verbs, not "Drive": one act, one word, wherever it
   * is offered.
   */
  it("connects an inactive host and offers disconnect on the active one", async () => {
    seed([host("h1", "active box"), host("h2", "spare", "disconnected")])
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-host-connect-h2")).toHaveTextContent("connect")
    expect(screen.queryByTestId("remote-host-connect-h1")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("remote-host-connect-h2"))
    expect(activateHost).toHaveBeenCalledWith("h2")

    await userEvent.click(screen.getByTestId("remote-host-disconnect-h1"))
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  it("asks before connecting while a turn is in flight", async () => {
    mockRunActive = true
    seed([host("h1", "active box"), host("h2", "spare", "disconnected")])
    render(<RemoteHostsPanel />)
    await userEvent.click(screen.getByTestId("remote-host-connect-h2"))
    expect(activateHost).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByTestId("execution-host-confirm"))
    expect(activateHost).toHaveBeenCalledWith("h2")
  })

  it("confirms before removing any host", async () => {
    seed([host("h1", "active box"), host("h2", "spare", "disconnected")])
    render(<RemoteHostsPanel />)
    await userEvent.click(screen.getByTestId("remote-host-remove-h2"))
    expect(removeHost).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByTestId("host-remove-confirm"))
    expect(removeHost).toHaveBeenCalledWith("h2")
  })

  it("names the switch back to local when removing the active host", async () => {
    mockRunActive = true
    seed([host("h1", "active box")])
    render(<RemoteHostsPanel />)
    await userEvent.click(screen.getByTestId("remote-host-remove-h1"))
    expect(await screen.findByTestId("execution-host-remove-active")).toHaveTextContent(
      "executionHost.removeActiveBusy"
    )
    expect(removeHost).not.toHaveBeenCalled()
  })

  it("shows the connection error under its row", () => {
    seed([
      host("h1", "active box", "degraded", { connectionError: "certificate fingerprint changed" }),
      host("h2", "spare", "disconnected"),
    ])
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-host-error-h1")).toHaveTextContent(
      "certificate fingerprint changed"
    )
    expect(screen.queryByTestId("remote-host-error-h2")).not.toBeInTheDocument()
    expect(screen.getByTestId("remote-host-state-h1")).toHaveAttribute("data-state", "degraded")
  })

  describe("rename", () => {
    beforeEach(() => seed([host("h1", "active box")]))

    it("commits on Enter", () => {
      render(<RemoteHostsPanel />)
      fireEvent.click(screen.getByLabelText("renameAria"))
      const input = screen.getByRole("textbox")
      fireEvent.change(input, { target: { value: "renamed" } })
      fireEvent.submit(input.closest("form")!)
      expect(updateHostLabel).toHaveBeenCalledWith("h1", "renamed")
    })

    /** Leaving the field by Tab or a click elsewhere keeps the edit. */
    it("commits on blur", () => {
      render(<RemoteHostsPanel />)
      fireEvent.click(screen.getByLabelText("renameAria"))
      const input = screen.getByRole("textbox")
      fireEvent.change(input, { target: { value: "blurred" } })
      fireEvent.blur(input)
      expect(updateHostLabel).toHaveBeenCalledWith("h1", "blurred")
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    })

    it("cancels on Escape, including the blur that follows", () => {
      render(<RemoteHostsPanel />)
      fireEvent.click(screen.getByLabelText("renameAria"))
      const input = screen.getByRole("textbox")
      fireEvent.change(input, { target: { value: "abandoned" } })
      fireEvent.keyDown(input, { key: "Escape" })
      fireEvent.blur(input)
      expect(updateHostLabel).not.toHaveBeenCalled()
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    })
  })

  /**
   * The scan button exists only where the pair step can scan (the native
   * mobile shell), so the description promises scanning only there.
   */
  it("promises scanning only where the scanner exists", () => {
    const { unmount } = render(<RemoteHostsPanel />)
    expect(screen.getByText("addDescription")).toBeInTheDocument()
    unmount()
    mockScanAvailable = true
    render(<RemoteHostsPanel />)
    expect(screen.getByText("addDescriptionScan")).toBeInTheDocument()
  })

  it("follows the store when the active host changes elsewhere", async () => {
    seed([host("h1", "active box"), host("h2", "spare")])
    render(<RemoteHostsPanel />)
    act(() => useRemoteHostStore.setState({ activeHostId: "h2" }))
    await waitFor(() =>
      expect(screen.getByTestId("remote-host-row-h2")).toHaveAttribute("data-active", "true")
    )
    expect(screen.getByTestId("remote-host-connect-h1")).toBeInTheDocument()
  })
})

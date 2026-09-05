import { fireEvent, render, screen } from "@testing-library/react"

import { RemoteHostsPanel } from "./remote-hosts-panel"

const activateHost = jest.fn()
const removeHost = jest.fn()
const updateHostLabel = jest.fn()
let hosts: Array<Record<string, unknown>> = []
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (s: unknown) => unknown) =>
    selector({ hosts, activeHostId: "h1", activateHost, removeHost, updateHostLabel }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.count !== undefined ? `${key}:${String(values.count)}` : key,
}))
jest.mock("@/components/connectivity/pair/add-host-form", () => ({
  AddHostForm: () => <div data-testid="add-host-form" />,
}))
jest.mock("@/components/devices/device-console-link", () => ({
  DeviceConsoleLink: ({ deviceRef }: { deviceRef?: string }) => (
    <div data-testid="device-console-link-hosts" data-ref={deviceRef ?? ""} />
  ),
}))
jest.mock("@/lib/devices/build-device-rows", () => ({
  remoteHostRef: (h: { id: string }) => `ref:${h.id}`,
}))

const host = (id: string, label: string, connectionState = "ready") => ({
  id,
  label,
  connectionState,
  config: { baseUrl: `https://${id}:27890` },
})

describe("RemoteHostsPanel", () => {
  beforeEach(() => {
    activateHost.mockReset()
    removeHost.mockReset()
    updateHostLabel.mockReset()
  })

  it("shows the empty state and opens the add form when nothing is registered", () => {
    hosts = []
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-hosts-empty")).toBeInTheDocument()
    expect(screen.getByTestId("add-host-form")).toBeInTheDocument()
  })

  it("drives, renames and removes a row and points the console at the active host", () => {
    hosts = [host("h1", "active box"), host("h2", "spare", "disconnected")]
    render(<RemoteHostsPanel />)
    expect(screen.getByTestId("remote-host-active")).toBeInTheDocument()
    expect(screen.getByTestId("device-console-link-hosts")).toHaveAttribute("data-ref", "ref:h1")
    fireEvent.click(screen.getByTestId("remote-host-drive-h2"))
    expect(activateHost).toHaveBeenCalledWith("h2")
    fireEvent.click(screen.getByTestId("remote-host-remove-h2"))
    expect(removeHost).toHaveBeenCalledWith("h2")
    fireEvent.click(screen.getAllByLabelText("renameAria")[0])
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "renamed" } })
    fireEvent.submit(input.closest("form")!)
    expect(updateHostLabel).toHaveBeenCalledWith("h1", "renamed")
  })
})

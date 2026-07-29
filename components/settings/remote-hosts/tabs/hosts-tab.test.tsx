/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { __resetRoutingForTests, getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  __setRemoteTransportFactoryForTests,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"
import { HostsTab } from "./hosts-tab"

const fakeRemote: Transport = {
  call: (async () => undefined) as Transport["call"],
  subscribe: () => () => {},
}

function config(baseUrl: string): CompanionConfig {
  return { baseUrl, deviceJwt: "jwt", deviceId: "d", serverVersion: "1.0.0" }
}

function seedHost(label: string, baseUrl: string) {
  return useRemoteHostStore.getState().addHost({ label, config: config(baseUrl) })
}

beforeEach(() => {
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  __resetRoutingForTests()
  __setRemoteTransportFactoryForTests(() => fakeRemote)
})
afterEach(() => {
  __setRemoteTransportFactoryForTests(null)
  __resetRoutingForTests()
})

it("shows the empty state when there are no hosts", () => {
  render(<HostsTab />)
  expect(screen.getByText("settings.remoteHosts.list.emptyTitle")).toBeInTheDocument()
})

it("lists a host and connects to it", async () => {
  const user = userEvent.setup()
  const host = seedHost("Dev box", "https://box.example:27890")
  render(<HostsTab />)

  expect(screen.getByText("Dev box")).toBeInTheDocument()
  expect(screen.getByText("https://box.example:27890")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.connect" }))

  await waitFor(() => expect(useRemoteHostStore.getState().activeHostId).toBe(host.id))
  expect(getActiveRemoteTransport()).not.toBeNull()
  expect(screen.getByText("settings.remoteHosts.list.activeBadge")).toBeInTheDocument()
})

it("disconnects the active host", async () => {
  const user = userEvent.setup()
  const host = seedHost("Dev box", "https://box.example:27890")
  useRemoteHostStore.getState().activateHost(host.id)
  render(<HostsTab />)

  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.disconnect" }))
  expect(useRemoteHostStore.getState().activeHostId).toBeNull()
  expect(getActiveRemoteTransport()).toBeNull()
})

it("renames a host", async () => {
  const user = userEvent.setup()
  const host = seedHost("Old name", "https://box.example:27890")
  render(<HostsTab />)

  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.rename" }))
  const input = screen.getByLabelText("settings.remoteHosts.list.renameLabel")
  await user.clear(input)
  await user.type(input, "New name")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.save" }))

  expect(useRemoteHostStore.getState().hosts.find((h) => h.id === host.id)?.label).toBe("New name")
})

it("cancels a rename without changing the label", async () => {
  const user = userEvent.setup()
  const host = seedHost("Keep me", "https://box.example:27890")
  render(<HostsTab />)

  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.rename" }))
  const input = screen.getByLabelText("settings.remoteHosts.list.renameLabel")
  await user.clear(input)
  await user.type(input, "Discarded")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.list.cancel" }))

  expect(useRemoteHostStore.getState().hosts.find((h) => h.id === host.id)?.label).toBe("Keep me")
  expect(screen.getByText("Keep me")).toBeInTheDocument()
})

it("removes a host", async () => {
  const user = userEvent.setup()
  seedHost("Dev box", "https://box.example:27890")
  render(<HostsTab />)

  await user.click(screen.getByRole("button", { name: /settings.remoteHosts.list.removeA11y/ }))
  expect(useRemoteHostStore.getState().hosts).toHaveLength(0)
})

it("lists the capabilities a host reported", () => {
  // Visibility is the point: before this a client had no way to know what the
  // host it drives can do, so workflow preflight judged a cloud server by the
  // desktop's own baseline.
  const host = seedHost("Cloud", "https://cloud.example")
  useRemoteHostStore.setState({
    hosts: useRemoteHostStore
      .getState()
      .hosts.map((h) => (h.id === host.id ? { ...h, capabilities: ["always-on", "headless"] } : h)),
  })

  render(<HostsTab />)
  const row = screen.getByTestId(`remote-host-capabilities-${host.id}`)
  expect(row).toHaveTextContent("always-on")
  expect(row).toHaveTextContent("headless")
})

it("says so plainly when a host has not been asked yet", () => {
  const host = seedHost("Cloud", "https://cloud.example")
  render(<HostsTab />)
  expect(screen.queryByTestId(`remote-host-capabilities-${host.id}`)).toBeNull()
  expect(screen.getByText("settings.remoteHosts.list.capabilitiesUnknown")).toBeInTheDocument()
})

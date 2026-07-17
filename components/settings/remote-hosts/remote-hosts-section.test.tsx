/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const replaceMock = jest.fn()
let searchParamsValue = new URLSearchParams("")
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParamsValue,
}))

import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { RemoteHostsSection } from "./remote-hosts-section"

beforeEach(() => {
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  replaceMock.mockClear()
  searchParamsValue = new URLSearchParams("")
})

it("renders the header and both tabs, defaulting to Hosts", () => {
  render(<RemoteHostsSection />)
  expect(screen.getByText("settings.remoteHosts.title")).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "settings.remoteHosts.tabs.hosts" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "settings.remoteHosts.tabs.add" })).toBeInTheDocument()
  // Default tab = hosts → the (empty) hosts list is shown.
  expect(screen.getByText("settings.remoteHosts.list.emptyTitle")).toBeInTheDocument()
})

it("reflects the active tab in the URL when Add host is clicked", async () => {
  const user = userEvent.setup()
  render(<RemoteHostsSection />)
  await user.click(screen.getByRole("tab", { name: "settings.remoteHosts.tabs.add" }))
  expect(replaceMock).toHaveBeenCalledWith("?remoteHostsTab=add", { scroll: false })
})

it("shows the Add host form when the URL selects the add tab", () => {
  searchParamsValue = new URLSearchParams("remoteHostsTab=add")
  render(<RemoteHostsSection />)
  expect(screen.getByLabelText("settings.remoteHosts.add.payloadLabel")).toBeInTheDocument()
})

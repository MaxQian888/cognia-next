import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import {
  DEFAULT_AUTHORITY_CONFIG,
  readExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
  __resetExecutionAuthorityConfigForTests,
} from "@/lib/placement/authority"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { SchedulerAuthorityControl } from "./scheduler-authority-control"

const messages = {
  scheduler: {
    authority: {
      label: "Fires on",
      thisHost: "This host",
      unknownHost: "Unavailable host ({host})",
      graceLabel: "Grace",
      graceMinutes: "{minutes} min",
      statusStoodDown: "{host} owns timing — this host stands down",
      statusWaiting: "{host} unreachable — taking over in {minutes} min",
      statusTakenOver: "{host} unreachable for {minutes} min — running here",
      statusUnknown: "{host} has never connected here — running here",
    },
  },
}

const NOW = 1_700_000_000_000

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "host-a",
    label: "Studio",
    config: { baseUrl: "https://studio.local" } as RemoteHost["config"],
    credentialRef: "cred-a",
    addedAt: NOW,
    connectionState: "ready",
    lastConnectedAt: NOW,
    ...overrides,
  }
}

function renderControl(props: Parameters<typeof SchedulerAuthorityControl>[0] = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SchedulerAuthorityControl now={() => NOW} {...props} />
    </NextIntlClientProvider>
  )
}

describe("SchedulerAuthorityControl", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    __resetExecutionAuthorityConfigForTests()
    useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  })

  it("renders nothing when there is no other host to hand timing to", () => {
    renderControl()
    expect(screen.queryByTestId("scheduler-authority-control")).not.toBeInTheDocument()
  })

  it("defaults to this host with a five-minute grace window", () => {
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    renderControl()
    expect(screen.getByRole("combobox", { name: "Fires on" })).toHaveTextContent("This host")
    expect(screen.getByRole("combobox", { name: "Grace" })).toHaveTextContent("5 min")
    expect(readExecutionAuthorityConfig()).toEqual(DEFAULT_AUTHORITY_CONFIG)
    expect(screen.queryByTestId("scheduler-authority-status")).not.toBeInTheDocument()
  })

  it("disables the grace window while this host owns timing", () => {
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    renderControl()
    expect(screen.getByRole("combobox", { name: "Grace" })).toBeDisabled()
  })

  it("persists a remote authority and re-arms the scheduler", async () => {
    const user = userEvent.setup()
    const onConfigChange = jest.fn()
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    renderControl({ onConfigChange })

    await user.click(screen.getByRole("combobox", { name: "Fires on" }))
    await user.click(await screen.findByRole("option", { name: "Studio" }))

    expect(readExecutionAuthorityConfig()).toEqual({
      hostId: "host-a",
      degradeAfterMs: 5 * 60_000,
    })
    expect(onConfigChange).toHaveBeenCalledWith({ hostId: "host-a", degradeAfterMs: 5 * 60_000 })
    expect(screen.getByTestId("scheduler-authority-status")).toHaveTextContent(
      "Studio owns timing — this host stands down"
    )
  })

  it("offers exactly the 1 / 5 / 15 minute grace windows and persists the choice", async () => {
    const user = userEvent.setup()
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 5 * 60_000 })
    renderControl({ onConfigChange: jest.fn() })

    await user.click(screen.getByRole("combobox", { name: "Grace" }))
    expect(await screen.findByRole("option", { name: "1 min" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "5 min" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "15 min" })).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(3)

    await user.click(screen.getByRole("option", { name: "15 min" }))
    expect(readExecutionAuthorityConfig()).toEqual({
      hostId: "host-a",
      degradeAfterMs: 15 * 60_000,
    })
  })

  it("says the authority is still inside its grace window", () => {
    useRemoteHostStore.setState({
      hosts: [host({ connectionState: "disconnected", lastConnectedAt: NOW - 2 * 60_000 })],
      activeHostId: null,
    })
    writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 5 * 60_000 })
    renderControl({ onConfigChange: jest.fn() })

    const status = screen.getByTestId("scheduler-authority-status")
    expect(status).toHaveTextContent("Studio unreachable — taking over in 3 min")
    expect(status).toHaveAttribute("data-tone", "warning")
  })

  it("says this host took over once the grace window has elapsed", () => {
    useRemoteHostStore.setState({
      hosts: [host({ connectionState: "disconnected", lastConnectedAt: NOW - 9 * 60_000 })],
      activeHostId: null,
    })
    writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 5 * 60_000 })
    renderControl({ onConfigChange: jest.fn() })

    expect(screen.getByTestId("scheduler-authority-status")).toHaveTextContent(
      "Studio unreachable for 9 min — running here"
    )
  })

  it("keeps a removed authority visible instead of silently reverting to this host", () => {
    useRemoteHostStore.setState({ hosts: [host({ id: "host-b", label: "Laptop" })] })
    writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 60_000 })
    renderControl({ onConfigChange: jest.fn() })

    expect(screen.getByRole("combobox", { name: "Fires on" })).toHaveTextContent(
      "Unavailable host (host-a)"
    )
    expect(screen.getByTestId("scheduler-authority-status")).toHaveTextContent(
      "host-a has never connected here — running here"
    )
  })

  it("keeps a legacy grace value that is not one of the offered windows", async () => {
    const user = userEvent.setup()
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 30 * 60_000 })
    renderControl({ onConfigChange: jest.fn() })

    expect(screen.getByRole("combobox", { name: "Grace" })).toHaveTextContent("30 min")
    await user.click(screen.getByRole("combobox", { name: "Grace" }))
    expect(screen.getAllByRole("option")).toHaveLength(4)
  })
})

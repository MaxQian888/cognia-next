import { act, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const hostTarget = {
  target: "local" as "local" | "paired",
  pairedAvailable: false,
  setTarget: jest.fn(),
}
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: () => hostTarget,
}))
const profileState = { value: "desktop" as string }
// `useRemoteHostActive` stays real and the routing plane is not mocked: the
// summary subscribes to it, so a test can attach a remote host under a mounted
// hook and watch the answer change.
jest.mock("@/hooks/use-host-profile", () => ({
  ...jest.requireActual("@/hooks/use-host-profile"),
  useHostProfile: () => profileState.value,
}))
interface RemoteHostRow {
  id: string
  label?: string
  config: { baseUrl: string }
}
const remoteState: { hosts: RemoteHostRow[]; activeHostId: string | null } = {
  hosts: [],
  activeHostId: null,
}
jest.mock("@/stores/remote-host/remote-host-store", () => {
  const hook = (selector: (s: typeof remoteState) => unknown) => selector(remoteState)
  hook.getState = () => remoteState
  return { useRemoteHostStore: hook }
})

import {
  __resetExecutionAuthorityConfigForTests,
  readExecutionAuthorityConfig,
} from "@/lib/placement/authority"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  SchedulerHostPopover,
  SchedulerHostStatusBadge,
  SchedulerHostSummaryLine,
  useSchedulerHostSummary,
} from "./scheduler-host-popover"

const remoteTransport: Transport = {
  call: jest.fn(async () => undefined) as Transport["call"],
  subscribe: jest.fn(() => () => undefined) as unknown as Transport["subscribe"],
}

afterEach(() => __resetRoutingForTests())

beforeEach(() => {
  globalThis.localStorage?.clear()
  __resetExecutionAuthorityConfigForTests()
  hostTarget.target = "local"
  hostTarget.pairedAvailable = false
  hostTarget.setTarget.mockClear()
  profileState.value = "desktop"
  remoteState.hosts = []
  remoteState.activeHostId = null
})

describe("useSchedulerHostSummary", () => {
  it("names this device with no paired host", () => {
    const { result } = renderHook(() => useSchedulerHostSummary())
    expect(result.current).toMatchObject({
      target: "local",
      label: "this device",
      suspended: false,
      onlyWhileOpen: false,
    })
  })

  it("marks the local schedule suspended while a desktop drives a remote host", () => {
    setActiveRemoteTransport(remoteTransport)
    remoteState.hosts = [{ id: "h1", label: "Studio", config: { baseUrl: "https://s" } }]
    remoteState.activeHostId = "h1"
    const { result } = renderHook(() => useSchedulerHostSummary())
    expect(result.current.suspended).toBe(true)
    expect(result.current.pairedLabel).toBe("cloud host Studio")
  })

  it("follows the desktop attaching to and detaching from a remote host", () => {
    remoteState.hosts = [{ id: "h1", label: "Studio", config: { baseUrl: "https://s" } }]
    remoteState.activeHostId = "h1"
    const { result } = renderHook(() => useSchedulerHostSummary())
    expect(result.current.suspended).toBe(false)

    act(() => setActiveRemoteTransport(remoteTransport))
    expect(result.current.suspended).toBe(true)
    expect(result.current.pairedLabel).toBe("cloud host Studio")

    act(() => setActiveRemoteTransport(null))
    expect(result.current.suspended).toBe(false)
  })

  it("says a companion's own schedule only ticks while open", () => {
    profileState.value = "mobile-companion"
    hostTarget.pairedAvailable = true
    const { result } = renderHook(() => useSchedulerHostSummary())
    expect(result.current.onlyWhileOpen).toBe(true)
    expect(result.current.pairedLabel).toBe("paired desktop")
    hostTarget.target = "paired"
    const paired = renderHook(() => useSchedulerHostSummary())
    expect(paired.result.current.label).toBe("paired desktop")
  })
})

describe("SchedulerHostPopover", () => {
  it("opens to the host summary and the switch, and flips the target", async () => {
    const user = userEvent.setup()
    hostTarget.pairedAvailable = true
    render(<SchedulerHostPopover />)
    await user.click(screen.getByTestId("scheduler-host-popover-trigger"))
    expect(await screen.findByTestId("scheduler-host-summary")).toHaveTextContent(
      "Managing: this device"
    )
    expect(screen.getByTestId("scheduler-host-only-open")).toBeInTheDocument()
    await user.click(screen.getByTestId("scheduler-host-switch"))
    expect(hostTarget.setTarget).toHaveBeenCalledWith("paired")
    expect(screen.queryByTestId("scheduler-authority-control")).not.toBeInTheDocument()
  })

  it("offers the timing authority when other hosts exist and persists a choice", async () => {
    const user = userEvent.setup()
    remoteState.hosts = [{ id: "h1", label: "Studio", config: { baseUrl: "https://s" } }]
    const onConfigChange = jest.fn()
    render(<SchedulerHostPopover onConfigChange={onConfigChange} now={() => 1_700_000_000_000} />)
    await user.click(screen.getByTestId("scheduler-host-popover-trigger"))
    expect(await screen.findByTestId("scheduler-authority-control")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Grace" })).toBeDisabled()
    await user.click(screen.getByRole("combobox", { name: "Fires on" }))
    await user.click(await screen.findByRole("option", { name: "Studio" }))
    expect(readExecutionAuthorityConfig().hostId).toBe("h1")
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ hostId: "h1" }))
    expect(screen.getByTestId("scheduler-authority-status")).toBeInTheDocument()
  })
})

describe("header pieces", () => {
  it("renders the summary line and the suspended badge", () => {
    const summary = {
      target: "local" as const,
      label: "this device",
      pairedAvailable: true,
      suspended: true,
      onlyWhileOpen: false,
      pairedLabel: "cloud host",
      setTarget: jest.fn(),
    }
    render(
      <>
        <SchedulerHostSummaryLine summary={summary} />
        <SchedulerHostStatusBadge summary={summary} />
      </>
    )
    expect(screen.getByTestId("scheduler-host-summary")).toHaveTextContent("this device")
    expect(screen.getByTestId("scheduler-host-suspended")).toBeInTheDocument()
  })
})

import { render, renderHook, screen } from "@testing-library/react"
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
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => profileState.value }))
const routing = { active: false }
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: () => routing.active }))
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
import {
  SchedulerHostPopover,
  SchedulerHostStatusBadge,
  SchedulerHostSummaryLine,
  useSchedulerHostSummary,
} from "./scheduler-host-popover"

beforeEach(() => {
  globalThis.localStorage?.clear()
  __resetExecutionAuthorityConfigForTests()
  hostTarget.target = "local"
  hostTarget.pairedAvailable = false
  hostTarget.setTarget.mockClear()
  profileState.value = "desktop"
  routing.active = false
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
    routing.active = true
    remoteState.hosts = [{ id: "h1", label: "Studio", config: { baseUrl: "https://s" } }]
    remoteState.activeHostId = "h1"
    const { result } = renderHook(() => useSchedulerHostSummary())
    expect(result.current.suspended).toBe(true)
    expect(result.current.pairedLabel).toBe("cloud host Studio")
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

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

import {
  useExecutionHostSwitch,
  type ExecutionHostSwitch,
  type ExecutionHostSwitchOutcome,
} from "./use-execution-host-switch"

function host(id: string, label: string): RemoteHost {
  return {
    id,
    label,
    credentialRef: `ref:${id}`,
    addedAt: 1,
    connectionState: "ready",
    config: { baseUrl: `https://${id}.example:27890`, serverVersion: "1.0.0" },
  } as RemoteHost
}

const initial = useRemoteHostStore.getState()
const activateHost = jest.fn()
const deactivate = jest.fn()
const removeHost = jest.fn()

function seed(hosts: RemoteHost[], activeHostId: string | null) {
  useRemoteHostStore.setState(
    { ...initial, hosts, activeHostId, activateHost, deactivate, removeHost },
    true
  )
}

/** Renders the hook and its dialog, handing the live API back to the test. */
function mount(): { api: () => ExecutionHostSwitch } {
  let current: ExecutionHostSwitch | null = null
  function Harness() {
    const value = useExecutionHostSwitch()
    current = value
    return value.dialog
  }
  render(<Harness />)
  return { api: () => current! }
}

beforeEach(() => {
  anyActive = false
  activateHost.mockClear()
  deactivate.mockClear()
  removeHost.mockClear()
  seed([host("h1", "Dev box"), host("h2", "Cloud")], null)
})

afterAll(() => useRemoteHostStore.setState(initial, true))

describe("requestSwitch", () => {
  it("switches straight away when nothing is running", async () => {
    const { api } = mount()
    const onSwitched = jest.fn()
    const onSettled = jest.fn()
    let outcome: ExecutionHostSwitchOutcome | undefined
    await act(async () => {
      outcome = await api().requestSwitch("h1", { onSwitched, onSettled })
    })
    expect(outcome).toBe("switched")
    expect(activateHost).toHaveBeenCalledWith("h1")
    expect(onSwitched).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith(true)
  })

  it("returns to local through deactivate", async () => {
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    await act(async () => {
      await api().requestSwitch(null)
    })
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  /**
   * Repointing the transport under a live turn strands it on the machine it
   * started on, with no error and a conversation that never finishes.
   */
  it("asks first when a turn is in flight, and switches only on confirm", async () => {
    anyActive = true
    const { api } = mount()
    const onSwitched = jest.fn()
    const onSettled = jest.fn()
    let outcome: ExecutionHostSwitchOutcome | undefined
    await act(async () => {
      outcome = await api().requestSwitch("h1", { onSwitched, onSettled })
    })
    expect(outcome).toBe("confirming")
    expect(activateHost).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'devices.executionHost.confirmBody:{"label":"Dev box"}'
    )

    await userEvent.click(screen.getByTestId("execution-host-confirm"))
    expect(activateHost).toHaveBeenCalledWith("h1")
    expect(onSwitched).toHaveBeenCalledTimes(1)
    // Settled once, as confirmed: the dialog's own close after the action
    // must not report the same request again as cancelled.
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith(true)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("leaves the transport alone when the user stays", async () => {
    anyActive = true
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    const onSwitched = jest.fn()
    const onSettled = jest.fn()
    await act(async () => {
      await api().requestSwitch(null, { onSwitched, onSettled })
    })
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'devices.executionHost.confirmBody:{"label":"devices.executionHost.local"}'
    )
    await userEvent.click(screen.getByText("devices.executionHost.confirmCancel"))
    expect(deactivate).not.toHaveBeenCalled()
    expect(onSwitched).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(false)
  })

  it("treats the host already active as done, without asking or re-running it", async () => {
    anyActive = true
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    const onSwitched = jest.fn()
    let outcome: ExecutionHostSwitchOutcome | undefined
    await act(async () => {
      outcome = await api().requestSwitch("h1", { onSwitched })
    })
    expect(outcome).toBe("unchanged")
    expect(activateHost).not.toHaveBeenCalled()
    expect(onSwitched).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  /**
   * Reconnect re-installs the transport, which disposes the one a live turn
   * is streaming over. It is a switch as far as that turn is concerned.
   */
  it("guards a reconnect of the active host with its own wording", async () => {
    anyActive = true
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    await act(async () => {
      await api().requestSwitch("h1", { reconnect: true })
    })
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "devices.executionHost.reconnectTitle"
    )
    await userEvent.click(screen.getByTestId("execution-host-confirm"))
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  it("re-runs the handshake straight away when nothing is running", async () => {
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    await act(async () => {
      await api().requestSwitch("h1", { reconnect: true })
    })
    expect(activateHost).toHaveBeenCalledWith("h1")
  })

  /**
   * "Connect after pairing" asks for a host it registered a moment ago, before
   * any re-render. The request must see it.
   */
  it("finds a host registered after the last render", async () => {
    seed([], null)
    const { api } = mount()
    act(() => useRemoteHostStore.setState({ hosts: [host("fresh", "Fresh")] }))
    let outcome: ExecutionHostSwitchOutcome | undefined
    await act(async () => {
      outcome = await api().requestSwitch("fresh")
    })
    expect(outcome).toBe("switched")
    expect(activateHost).toHaveBeenCalledWith("fresh")
  })

  it("refuses an id that is not in the registry", async () => {
    const { api } = mount()
    const onSettled = jest.fn()
    let outcome: ExecutionHostSwitchOutcome | undefined
    await act(async () => {
      outcome = await api().requestSwitch("ghost", { onSettled })
    })
    expect(outcome).toBe("unknown-host")
    expect(activateHost).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(false)
  })

  it("answers a superseded pending request as not switched", async () => {
    anyActive = true
    const { api } = mount()
    const first = jest.fn()
    await act(async () => {
      await api().requestSwitch("h1", { onSettled: first })
    })
    await act(async () => {
      await api().requestSwitch("h2")
    })
    expect(first).toHaveBeenCalledWith(false)
    expect(screen.getByRole("alertdialog")).toHaveTextContent('{"label":"Cloud"}')
  })
})

describe("requestRemove", () => {
  it("always confirms, even for an idle host with nothing running", async () => {
    const { api } = mount()
    const onRemoved = jest.fn()
    await act(async () => {
      await api().requestRemove("h2", { onRemoved })
    })
    expect(removeHost).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'devices.host.removeBody:{"label":"Cloud"}'
    )
    // Not the active host: nothing about where calls land changes.
    expect(screen.queryByTestId("execution-host-remove-active")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("host-remove-confirm"))
    expect(removeHost).toHaveBeenCalledWith("h2")
    expect(onRemoved).toHaveBeenCalledTimes(1)
  })

  it("does nothing on cancel", async () => {
    const { api } = mount()
    await act(async () => {
      await api().requestRemove("h2")
    })
    await userEvent.click(screen.getByText("devices.host.cancel"))
    expect(removeHost).not.toHaveBeenCalled()
  })

  it("says removing the active host returns this window to local", async () => {
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    await act(async () => {
      await api().requestRemove("h1")
    })
    expect(screen.getByTestId("execution-host-remove-active")).toHaveTextContent(
      'devices.executionHost.removeActive:{"label":"Dev box"}'
    )
  })

  /**
   * Removing the active host deactivates it, so it is held to the same
   * in-flight guard as a switch, folded into the one removal dialog.
   */
  it("warns about the in-flight turn when removing the active host", async () => {
    anyActive = true
    seed([host("h1", "Dev box")], "h1")
    const { api } = mount()
    await act(async () => {
      await api().requestRemove("h1")
    })
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1)
    expect(screen.getByTestId("execution-host-remove-active")).toHaveTextContent(
      "devices.executionHost.removeActiveBusy"
    )
    await userEvent.click(screen.getByTestId("host-remove-confirm"))
    expect(removeHost).toHaveBeenCalledWith("h1")
  })
})

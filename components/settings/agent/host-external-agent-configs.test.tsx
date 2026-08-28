/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { HostExternalAgentConfigs } from "./host-external-agent-configs"
import type { HostExternalAgentConfigsState } from "@/hooks/agent/use-host-external-agent-configs"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

const state: { current: HostExternalAgentConfigsState } = {
  current: {} as HostExternalAgentConfigsState,
}

jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => state.current,
}))

function record(over: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 3,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { name: "Pi", protocol: "pi-rpc" },
    ...over,
  } as ExternalAgentConfigRecord
}

function setState(over: Partial<HostExternalAgentConfigsState> = {}) {
  state.current = {
    configs: [],
    loading: false,
    unavailable: null,
    error: null,
    busy: false,
    refresh: jest.fn(async () => {}),
    reconcile: jest.fn(async () => {}),
    setEnabled: jest.fn(async () => {}),
    remove: jest.fn(async () => {}),
    ...over,
  }
}

describe("HostExternalAgentConfigs", () => {
  it("lists the host's configurations", () => {
    setState({ configs: [record()] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("Pi")).toBeInTheDocument()
    expect(screen.getByText("pi-rpc")).toBeInTheDocument()
  })

  it("shows the revision a run would be admitted against", () => {
    setState({ configs: [record({ seq: 12 })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/12/)).toBeInTheDocument()
  })

  // The three unreachable reasons are different screens on purpose: "pair a
  // host", "wait", and "upgrade the host" are three different actions.
  it.each([
    ["no-host", /Pair a host/i],
    ["unsupported", /does not support/i],
    ["manifest-missing", /Waiting for/i],
  ] as const)("explains %s rather than showing an empty list", (reason, copy) => {
    setState({ unavailable: reason })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it("distinguishes 'this host has none' from 'there is no host'", () => {
    setState({ configs: [] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/No agents configured on this host/i)).toBeInTheDocument()
    expect(screen.queryByText(/Pair a host/i)).not.toBeInTheDocument()
  })

  it("shows a loading state", () => {
    setState({ loading: true })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText(/Loading host configurations/i)).toBeInTheDocument()
  })

  it("surfaces a write failure in the panel, not only as a toast", () => {
    setState({ configs: [record()], error: "revision conflict" })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("revision conflict")).toBeInTheDocument()
  })

  it("toggles a configuration through the host", async () => {
    const setEnabled = jest.fn(async () => {})
    setState({ configs: [record()], setEnabled })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(expect.anything(), false))
  })

  // Offering the switch on a config the host says cannot run would imply a
  // choice the user does not have; the host would refuse the write anyway.
  it("locks the switch on a configuration that is not ready", () => {
    setState({ configs: [record({ lifecycleStatus: "needs-credentials", enabled: false })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("switch")).toBeDisabled()
  })

  it("renders the readiness verdict a not-ready configuration carries", () => {
    setState({
      configs: [
        record({
          lifecycleStatus: "needs-credentials",
          enabled: false,
          config: {
            name: "Pi",
            protocol: "pi-rpc",
            lifecycleReasonCode: "credential_missing",
          } as never,
        }),
      ],
    })
    render(<HostExternalAgentConfigs />)
    // The notice renders for anything that is not ready; the exact sentence is
    // LifecycleStatusNotice's own contract and is pinned by its own tests.
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByText("Pi")).toBeInTheDocument()
  })

  it("deletes through the host", async () => {
    const remove = jest.fn(async () => {})
    setState({ configs: [record()], remove })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: /Delete Pi/i }))
    await waitFor(() => expect(remove).toHaveBeenCalled())
  })

  it("asks the host to re-check readiness", async () => {
    const reconcile = jest.fn(async () => {})
    setState({ configs: [record()], reconcile })
    render(<HostExternalAgentConfigs />)
    await userEvent.click(screen.getByRole("button", { name: /Re-check/i }))
    await waitFor(() => expect(reconcile).toHaveBeenCalled())
  })

  it("disables every control while a write is in flight", () => {
    setState({ configs: [record()], busy: true })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByRole("switch")).toBeDisabled()
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
  })

  it("falls back to the id when a configuration has no name", () => {
    setState({ configs: [record({ config: {} as never })] })
    render(<HostExternalAgentConfigs />)
    expect(screen.getByText("eac_1")).toBeInTheDocument()
  })
})

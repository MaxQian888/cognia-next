import { render, screen } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"

import { ActivityTab, summarizeProvides } from "./activity-tab"

const jobs: unknown[] = []
const listForTarget = jest.fn()

// Invoke the querier so the Dexie call this component makes is observable —
// the point of these tests is *which key* it queries with.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => {
    void querier()
    return jobs
  },
}))
jest.mock("@/lib/db/host-dispatch-queue", () => ({
  listHostDispatchForTarget: (ref: string) => listForTarget(ref),
}))

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:d1",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    deviceId: "d1",
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

beforeEach(() => {
  jobs.length = 0
  jest.clearAllMocks()
})

describe("summarizeProvides", () => {
  it("counts requirements per dimension", () => {
    expect(
      summarizeProvides(
        row({
          placement: {
            provides: [
              { dimension: "platform", value: "camera" },
              { dimension: "platform", value: "webview" },
              { dimension: "sandbox", value: "os" },
            ],
            activeUnits: 0,
            maxUnits: Number.POSITIVE_INFINITY,
          },
        })
      )
    ).toEqual({ platform: 2, sandbox: 1 })
  })
})

describe("ActivityTab — dispatch queue", () => {
  /**
   * `HostDispatchJobRow.targetRef` is in the target's own vocabulary — a raw
   * `deviceId`, not the console's namespaced ref. Querying with the namespaced
   * one returns nothing, which reads as "no work has ever been sent here".
   */
  it("queries with the raw deviceId, not the namespaced console ref", () => {
    render(<ActivityTab row={row()} />)
    expect(listForTarget).toHaveBeenCalledWith("d1")
  })

  it("queries a worker by its hostRef", () => {
    render(<ActivityTab row={row({ ref: "worker-1", kind: "worker", deviceId: "w1" })} />)
    expect(listForTarget).toHaveBeenCalledWith("worker-1")
  })

  it("says the local machine is not addressed by the queue at all", () => {
    render(<ActivityTab row={row({ ref: "local", kind: "local", deviceId: undefined })} />)
    expect(
      screen.getByText("This device is not addressed by the dispatch queue.")
    ).toBeInTheDocument()
    expect(listForTarget).not.toHaveBeenCalled()
  })

  it("shows an empty queue as empty rather than as an error", () => {
    render(<ActivityTab row={row()} />)
    expect(screen.getByText("Nothing dispatched")).toBeInTheDocument()
  })

  /** Terminal rows are shown too: hiding failures answers only the easy half. */
  it("renders failed rows with their attempts and error", () => {
    jobs.push({
      id: "j1",
      domain: "mobile-step",
      kind: "action.mobile.notify",
      status: "deadletter",
      attempts: 3,
      maxAttempts: 3,
      lastError: "device denied the prompt",
      createdAt: 1_700_000_000_000,
    })
    render(<ActivityTab row={row()} />)
    expect(screen.getByTestId("dispatch-job-j1")).toBeInTheDocument()
    expect(screen.getByText("Dead-lettered")).toBeInTheDocument()
    expect(screen.getByText("attempt 3 of 3")).toBeInTheDocument()
    expect(screen.getByText("device denied the prompt")).toBeInTheDocument()
    expect(screen.getByText("Workflow step on a device")).toBeInTheDocument()
  })
})

describe("ActivityTab — placement", () => {
  it("lists what the device offers, per dimension", () => {
    render(
      <ActivityTab
        row={row({
          placement: {
            provides: [
              { dimension: "platform", value: "camera" },
              { dimension: "host-feature", value: "workflow.execution" },
            ],
            activeUnits: 0,
            maxUnits: Number.POSITIVE_INFINITY,
          },
        })}
      />
    )
    expect(screen.getByText("Platform")).toBeInTheDocument()
    expect(screen.getByText("Host feature")).toBeInTheDocument()
  })

  /**
   * A machine that never gets picked usually provides nothing in the dimension
   * the caller asked for, and that was previously invisible everywhere.
   */
  it("says plainly when a device can never be selected automatically", () => {
    render(<ActivityTab row={row()} />)
    expect(screen.getByText(/never be selected automatically/)).toBeInTheDocument()
  })
})

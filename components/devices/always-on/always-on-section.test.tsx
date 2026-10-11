import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))
jest.mock("@/lib/remote-host/migration/service", () => ({
  requestMigrationLease: jest.fn(),
  takeBackItem: jest.fn(),
  resumeMove: jest.fn(),
  finishPendingTakeBack: jest.fn(),
  moveItems: jest.fn(),
  preflightMigration: jest.fn(),
}))
jest.mock("@/lib/remote-host/migration/candidates", () => ({ loadAlwaysOnWork: jest.fn() }))

import type { ItemMigrationRow } from "@/lib/db/item-migrations"
import type { DeviceRow } from "@/lib/devices/types"
import type { AlwaysOnWork } from "@/lib/remote-host/migration/candidates"
import type { MigrationOutcome } from "@/lib/remote-host/migration/types"
import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"

import { AlwaysOnSection, type AlwaysOnSectionDeps } from "./always-on-section"

const row = {
  ref: "host:mini",
  kind: "remote-host",
  label: "Mac mini",
  hostId: "mini",
} as DeviceRow

const moved = {
  ref: { kind: "scheduled-task" as const, id: "t1" },
  label: "Morning digest",
}

function operation(overrides: Partial<ItemMigrationRow>): ItemMigrationRow {
  return {
    operationId: "op-1",
    direction: "move",
    itemKind: "scheduled-task",
    itemId: "t9",
    itemLabel: "Weekly report",
    hostId: "mini",
    hostLabel: "Mac mini",
    localStatus: "active",
    state: "failed",
    resumeFrom: "fenced",
    error: "relay dropped",
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function work(overrides: Partial<AlwaysOnWork> = {}): AlwaysOnWork {
  return { local: [], movedHere: [moved], unfinished: [], ...overrides }
}

const lease = { token: "lease", operations: [], expiresAt: Date.now() + 600_000 }

function renderSection(deps: AlwaysOnSectionDeps) {
  return render(<AlwaysOnSection row={row} deps={{ requestLease: async () => lease, ...deps }} />)
}

beforeEach(() => jest.clearAllMocks())

describe("AlwaysOnSection", () => {
  it("lists what the host runs for this device", async () => {
    renderSection({ load: async () => work() })
    expect(await screen.findByTestId("always-on-moved")).toHaveTextContent("Morning digest")
    expect(screen.getByTestId("always-on-move")).toBeDisabled()
  })

  it("takes an item back under the lease and reads again", async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(work())
      .mockResolvedValue(work({ movedHere: [] }))
    const takeBack = jest.fn(async () => ({
      item: moved.ref,
      operationId: "op",
      ok: true,
      state: "completed",
    }))
    renderSection({ load, takeBack })
    fireEvent.click(await screen.findByTestId("always-on-take-back-t1"))
    await waitFor(() => expect(takeBack).toHaveBeenCalledWith(moved.ref, { adminLease: "lease" }))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(toastSuccess).toHaveBeenCalledWith("“Morning digest” done.")
  })

  it("offers to take back without the host, saying what that means", async () => {
    const takeBack = jest.fn(async () => ({
      item: moved.ref,
      operationId: "op",
      ok: true,
      state: "awaiting-host",
    }))
    renderSection({
      load: async () => work(),
      takeBack,
      requestLease: async () => {
        throw new Error("no route to host")
      },
    })
    fireEvent.click(await screen.findByTestId("always-on-take-back-t1"))
    const dialog = await screen.findByTestId("always-on-unreachable")
    expect(dialog).toHaveTextContent("no route to host")
    expect(dialog).toHaveTextContent("may run in both places")
    expect(takeBack).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("always-on-take-back-anyway"))
    await waitFor(() =>
      expect(takeBack).toHaveBeenCalledWith(moved.ref, { evenIfHostUnreachable: true })
    )
    expect(toastSuccess.mock.calls[0]?.[0]).toContain(
      "removed the next time Mac mini can be reached"
    )
  })

  it("resumes an interrupted move, and finishes a take-back waiting on the host", async () => {
    const resume = jest.fn(async (): Promise<MigrationOutcome> => ({
      item: { kind: "scheduled-task", id: "t9" },
      operationId: "op-1",
      ok: true,
      state: "completed",
    }))
    const finish = jest.fn(async (): Promise<MigrationOutcome> => ({
      item: { kind: "scheduled-task", id: "t8" },
      operationId: "op-2",
      ok: true,
      state: "completed",
    }))
    renderSection({
      load: async () =>
        work({
          unfinished: [
            operation({}),
            operation({
              operationId: "op-2",
              direction: "take-back",
              itemId: "t8",
              itemLabel: "Inbox sweep",
              state: "awaiting-host",
              error: undefined,
            }),
          ],
        }),
      resume,
      finish,
    })
    const unfinished = await screen.findByTestId("always-on-unfinished")
    expect(unfinished).toHaveTextContent("relay dropped")
    fireEvent.click(screen.getByTestId("always-on-continue-op-1"))
    await waitFor(() => expect(resume).toHaveBeenCalledWith("op-1", { adminLease: "lease" }))
    fireEvent.click(screen.getByTestId("always-on-continue-op-2"))
    await waitFor(() => expect(finish).toHaveBeenCalledWith("op-2", { adminLease: "lease" }))
  })

  it("shows the host's approval code and continues the action once approved", async () => {
    const requestLease = jest
      .fn()
      .mockRejectedValueOnce(new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", "K7Q2"))
      .mockResolvedValue(lease)
    const takeBack = jest.fn(async () => ({
      item: moved.ref,
      operationId: "op",
      ok: true,
      state: "completed",
    }))
    renderSection({ load: async () => work(), requestLease, takeBack })
    fireEvent.click(await screen.findByTestId("always-on-take-back-t1"))
    expect(await screen.findByTestId("always-on-consent")).toHaveTextContent("K7Q2")
    expect(takeBack).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("always-on-consent-continue"))
    await waitFor(() => expect(takeBack).toHaveBeenCalledTimes(1))
  })

  it("renders nothing for a host with no store id", () => {
    const { container } = render(
      <AlwaysOnSection row={{ ...row, hostId: undefined }} deps={{ load: async () => work() }} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

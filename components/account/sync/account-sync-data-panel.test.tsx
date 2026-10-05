/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { AccountSyncEngine, EngineStatus } from "@/lib/account-sync/data/engine"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { AccountSyncDataPanel } from "./account-sync-data-panel"

const running = (
  patch: Partial<Extract<EngineStatus, { kind: "running" }>> = {}
): EngineStatus => ({
  kind: "running",
  live: "socket",
  pending: 0,
  parked: { schema: 0, key: 0 },
  lastSyncedAt: null,
  tooLarge: [],
  error: null,
  classes: { content: true, settings: true },
  ...patch,
})

function withEngine(status: EngineStatus | null) {
  const engine = {
    syncNow: jest.fn(),
    setClasses: jest.fn(async () => undefined),
  } as unknown as AccountSyncEngine & { syncNow: jest.Mock; setClasses: jest.Mock }
  act(() => {
    useAccountSyncStore.getState().setEngine(engine)
    useAccountSyncStore.getState().setEngineStatus(status)
  })
  return engine
}

beforeEach(() => useAccountSyncStore.getState().reset())

describe("AccountSyncDataPanel", () => {
  it("says data syncs where it lives when this window runs no engine", () => {
    render(<AccountSyncDataPanel />)
    expect(screen.getByTestId("account-sync-data")).toHaveTextContent("notHere")
  })

  it("shows starting, follower and seeding progress", () => {
    render(<AccountSyncDataPanel />)
    withEngine({ kind: "starting" })
    expect(screen.getByRole("status")).toHaveTextContent("starting")
    act(() => useAccountSyncStore.getState().setEngineStatus({ kind: "follower" }))
    expect(screen.getByTestId("account-sync-data")).toHaveTextContent("follower")
    act(() =>
      useAccountSyncStore
        .getState()
        .setEngineStatus({ kind: "seeding", progress: { table: "sessions", done: 3, total: 9 } })
    )
    expect(screen.getByRole("status")).toHaveTextContent("seedingProgress(3,9)")
  })

  it("reopens the join choice", () => {
    render(<AccountSyncDataPanel />)
    withEngine({ kind: "join-choice", local: { counts: {} as never, total: 2 }, remoteSeq: 4 })
    act(() => useAccountSyncStore.getState().setJoinDialogOpen(false))
    fireEvent.click(screen.getByTestId("account-sync-open-join"))
    expect(useAccountSyncStore.getState().joinDialogOpen).toBe(true)
  })

  it("reports a running engine: live mode, waiting changes, parked and oversized rows, errors", () => {
    render(<AccountSyncDataPanel />)
    const engine = withEngine(
      running({
        live: "poll",
        pending: 3,
        lastSyncedAt: Date.UTC(2026, 9, 6, 8),
        parked: { schema: 2, key: 1 },
        tooLarge: ["sessions:big"],
        error: "network",
      })
    )
    const line = screen.getByRole("status")
    expect(line).toHaveAttribute("data-live", "poll")
    expect(line).toHaveTextContent("live.poll")
    expect(line).toHaveTextContent("pending(3)")
    expect(line).toHaveTextContent(new Date(Date.UTC(2026, 9, 6, 8)).toLocaleTimeString())
    expect(screen.getByTestId("account-sync-data-error")).toHaveTextContent("error(network)")
    expect(screen.getByTestId("account-sync-parked-schema")).toHaveTextContent("parkedSchema(2)")
    expect(screen.getByTestId("account-sync-parked-key")).toHaveTextContent("parkedKey(1)")
    expect(screen.getByTestId("account-sync-too-large")).toHaveTextContent("tooLarge(1)")
    fireEvent.click(screen.getByTestId("account-sync-sync-now"))
    expect(engine.syncNow).toHaveBeenCalled()
  })

  it("switches a class through the engine, and says when that failed", async () => {
    render(<AccountSyncDataPanel />)
    const engine = withEngine(running())
    fireEvent.click(screen.getByTestId("account-sync-class-content"))
    await waitFor(() =>
      expect(engine.setClasses).toHaveBeenCalledWith({ content: false, settings: true })
    )
    engine.setClasses.mockRejectedValueOnce(new Error("not syncing"))
    fireEvent.click(screen.getByTestId("account-sync-class-settings"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("failed(not syncing)"))
  })

  it("shows nothing more for a removed device", () => {
    render(<AccountSyncDataPanel />)
    withEngine({ kind: "removed", removal: { at: 1, seq: 2, by: "dev_x" } })
    expect(screen.queryByRole("status")).toBeNull()
  })
})

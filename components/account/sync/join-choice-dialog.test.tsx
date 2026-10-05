/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
const runBackup = jest.fn()
jest.mock("@/hooks/data/use-full-backup", () => ({
  useFullBackup: () => ({ run: runBackup, busy: false }),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { AccountSyncEngine } from "@/lib/account-sync/data/engine"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { JoinChoiceDialog } from "./join-choice-dialog"

function asking() {
  const engine = {
    join: jest.fn(async (_choice: string, backup: () => Promise<void>) => {
      await backup()
    }),
  } as unknown as AccountSyncEngine & { join: jest.Mock }
  act(() => {
    useAccountSyncStore.getState().setEngine(engine)
    useAccountSyncStore.getState().setEngineStatus({
      kind: "join-choice",
      local: {
        counts: { sessions: 3, messages: 40, characters: 0, skills: 1, memories: 0, settings: 2 },
        total: 44,
      },
      remoteSeq: 12,
    })
  })
  return engine
}

beforeEach(() => {
  useAccountSyncStore.getState().reset()
  runBackup.mockReset()
})

describe("JoinChoiceDialog", () => {
  it("renders nothing unless the engine asks", () => {
    render(<JoinChoiceDialog />)
    expect(screen.queryByTestId("account-sync-join-choice")).toBeNull()
  })

  it("lists what this device holds and merges by default after an auto-key backup", async () => {
    runBackup.mockResolvedValue({ ok: true, canceled: false, filename: "f", sizeBytes: 1 })
    render(<JoinChoiceDialog />)
    const engine = asking()
    const counts = screen.getByTestId("account-sync-join-counts")
    expect(counts).toHaveTextContent("counts.sessions(3)")
    expect(counts).toHaveTextContent("counts.messages(40)")
    expect(counts).toHaveTextContent("counts.skills(1)")
    expect(counts).not.toHaveTextContent("counts.characters")

    fireEvent.click(screen.getByTestId("account-sync-join-continue"))
    await waitFor(() => expect(engine.join).toHaveBeenCalled())
    expect(engine.join.mock.calls[0]![0]).toBe("merge")
    expect(runBackup).toHaveBeenCalledWith({
      includeSessions: true,
      includeApiKey: false,
      encryption: "auto-key",
      type: "auto",
    })
  })

  it("replaces when chosen", async () => {
    runBackup.mockResolvedValue({ ok: true, canceled: false, filename: "f", sizeBytes: 1 })
    render(<JoinChoiceDialog />)
    const engine = asking()
    fireEvent.click(screen.getByTestId("account-sync-join-replace"))
    fireEvent.click(screen.getByTestId("account-sync-join-continue"))
    await waitFor(() => expect(engine.join).toHaveBeenCalled())
    expect(engine.join.mock.calls[0]![0]).toBe("replace")
  })

  it("says nothing changed when the backup is cancelled or fails", async () => {
    render(<JoinChoiceDialog />)
    asking()
    runBackup.mockResolvedValueOnce({ ok: true, canceled: true })
    fireEvent.click(screen.getByTestId("account-sync-join-continue"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("canceled"))
    runBackup.mockResolvedValueOnce({ ok: false, error: "disk full" })
    fireEvent.click(screen.getByTestId("account-sync-join-continue"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("failed(disk full)"))
  })

  it("closes for later", () => {
    render(<JoinChoiceDialog />)
    asking()
    fireEvent.click(screen.getByTestId("account-sync-join-later"))
    expect(useAccountSyncStore.getState().joinDialogOpen).toBe(false)
    expect(screen.queryByTestId("account-sync-join-choice")).toBeNull()
  })
})

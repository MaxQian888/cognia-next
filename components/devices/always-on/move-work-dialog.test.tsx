import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { UseMigrationLeaseResult } from "@/hooks/remote-host/use-migration-lease"
import type { AlwaysOnItem } from "@/lib/remote-host/migration/candidates"
import type { MigrationPreflight } from "@/lib/remote-host/migration/types"

jest.mock("@/lib/remote-host/migration/service", () => ({
  moveItems: jest.fn(),
  preflightMigration: jest.fn(),
}))
jest.mock("@/lib/remote-host/migration/plugin-transfer", () => ({
  ...jest.requireActual("@/lib/remote-host/migration/plugin-transfer"),
  transferPlugins: jest.fn(),
}))

import { MoveWorkDialog, type MoveWorkDialogDeps } from "./move-work-dialog"

const items: AlwaysOnItem[] = [
  { ref: { kind: "scheduled-task", id: "t1" }, label: "Morning digest" },
  { ref: { kind: "bot-installation", id: "b1" }, label: "Helper" },
  { ref: { kind: "scheduled-task", id: "t2" }, label: "Backup" },
]

function preflight(
  id: string,
  label: string,
  blockers: MigrationPreflight["blockers"] = [],
  kind: MigrationPreflight["item"]["kind"] = "scheduled-task"
): MigrationPreflight {
  return {
    item: { kind, id },
    label,
    localStatus: "active",
    ready: blockers.length === 0,
    blockers,
    notes: [],
    plugins: [],
    checkedAt: 1,
  }
}

const answer = [
  preflight("t1", "Morning digest"),
  preflight(
    "b1",
    "Helper",
    [{ kind: "plugin-missing", pluginId: "acme-notes", version: "1.0.0" }],
    "bot-installation"
  ),
  preflight("t2", "Backup", [
    { kind: "machine-bound", reason: { kind: "machine-maintenance", taskType: "backup" } },
  ]),
]

function lease(overrides: Partial<UseMigrationLeaseResult> = {}): UseMigrationLeaseResult {
  return {
    acquire: jest.fn(async () => "lease"),
    awaitingConsent: null,
    requesting: false,
    forget: jest.fn(),
    ...overrides,
  }
}

function renderDialog(
  deps: MoveWorkDialogDeps,
  leaseValue = lease(),
  onChanged = jest.fn(),
  autoMove = false
) {
  render(
    <MoveWorkDialog
      open
      onOpenChange={jest.fn()}
      hostId="mini"
      hostLabel="Mac mini"
      items={items}
      lease={leaseValue}
      onChanged={onChanged}
      autoMove={autoMove}
      deps={deps}
    />
  )
  return { onChanged }
}

describe("MoveWorkDialog", () => {
  it("asks the host first, then groups what can move, what needs plugins and what stays", async () => {
    const preflightMock = jest.fn(async () => answer)
    renderDialog({ preflight: preflightMock, canTransferPlugins: true })
    expect(screen.getByTestId("move-checking")).toBeInTheDocument()
    await screen.findByTestId("move-ready")
    expect(preflightMock).toHaveBeenCalledWith(
      "mini",
      items.map((item) => item.ref)
    )
    expect(screen.getByTestId("move-select-t1")).toBeChecked()
    expect(screen.getByTestId("move-needs-plugins")).toHaveTextContent(
      "Needs the plugin acme-notes 1.0.0, which Mac mini does not have."
    )
    expect(screen.getByTestId("move-stays-here")).toHaveTextContent(
      "Looks after this device's own data."
    )
  })

  it("moves the selected items under the lease and reports each", async () => {
    const move = jest.fn(async (_host, refs, options) => {
      options.onProgress?.({ item: refs[0], operationId: "op", ok: true, state: "completed" })
      return [{ item: refs[0], operationId: "op", ok: true, state: "completed" }]
    })
    const { onChanged } = renderDialog({ preflight: async () => answer, move })
    fireEvent.click(await screen.findByTestId("move-confirm"))
    await screen.findByTestId("move-done")
    expect(move).toHaveBeenCalledWith(
      "mini",
      [{ kind: "scheduled-task", id: "t1" }],
      expect.objectContaining({ adminLease: "lease" })
    )
    expect(screen.getByTestId("move-done")).toHaveTextContent(
      "Morning digest now runs on Mac mini."
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it("shows the host's approval code and continues once approved", async () => {
    const acquire = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("lease")
    const move = jest.fn(async () => [])
    const leaseValue = lease({ acquire, awaitingConsent: { code: "K7Q2" } })
    renderDialog({ preflight: async () => answer, move }, leaseValue)
    fireEvent.click(await screen.findByTestId("move-confirm"))
    expect(await screen.findByTestId("move-consent")).toHaveTextContent("K7Q2")
    expect(move).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("move-consent-continue"))
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1))
  })

  it("sends the missing plugins, then asks the host again", async () => {
    const preflightMock = jest
      .fn()
      .mockResolvedValueOnce(answer)
      .mockResolvedValueOnce([
        answer[0],
        preflight("b1", "Helper", [], "bot-installation"),
        answer[2],
      ])
    const transfer = jest.fn(async () => ({
      fingerprint: "f",
      installed: [{ pluginId: "acme-notes", version: "1.0.0" }],
      failed: [],
    }))
    renderDialog({ preflight: preflightMock, transfer, canTransferPlugins: true })
    fireEvent.click(await screen.findByTestId("move-send-plugins"))
    await waitFor(() => expect(preflightMock).toHaveBeenCalledTimes(2))
    expect(transfer).toHaveBeenCalledWith(
      "mini",
      [{ pluginId: "acme-notes", version: "1.0.0" }],
      expect.objectContaining({ adminLease: "lease" })
    )
    // The item the plugins unblocked is now ready, and selected.
    expect(await screen.findByTestId("move-select-b1")).toBeChecked()
    expect(screen.getByTestId("move-plugin-result")).toHaveTextContent(
      "Mac mini installed 1 plugins."
    )
  })

  it("does not offer plugin transfer where plugin files cannot be read", async () => {
    renderDialog({ preflight: async () => answer, canTransferPlugins: false })
    expect(await screen.findByTestId("move-send-plugins")).toBeDisabled()
    expect(screen.getByTestId("move-needs-plugins")).toHaveTextContent(
      "Plugins can only be sent from the desktop app"
    )
  })

  it("moves a new item on its own when the host can take it, and keeps the rest here", async () => {
    const move = jest.fn(async (_host, refs) =>
      refs.map((ref: { kind: string; id: string }) => ({
        item: ref,
        operationId: "op",
        ok: true,
        state: "completed",
      }))
    )
    renderDialog({ preflight: async () => answer, move }, lease(), jest.fn(), true)
    await screen.findByTestId("move-done")
    expect(move).toHaveBeenCalledTimes(1)
    expect(move.mock.calls[0]?.[1]).toEqual([{ kind: "scheduled-task", id: "t1" }])
  })

  it("says why it could not ask the host", async () => {
    renderDialog({
      preflight: async () => {
        throw new Error("no route to host")
      },
    })
    expect(await screen.findByTestId("move-failed")).toHaveTextContent("no route to host")
    await act(async () => undefined)
  })
})

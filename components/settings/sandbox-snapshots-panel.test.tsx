import { selectOption } from "@/lib/testing/select-option"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SandboxSnapshotsPanel } from "./sandbox-snapshots-panel"
import { useSandboxSnapshots } from "@/hooks/sandbox/use-sandbox-snapshots"
import type { SandboxPreviewContext } from "@/lib/sandbox/previews"
import en from "@/i18n/messages/en/sandboxManagement.json"
import zh from "@/i18n/messages/zh-CN/sandboxManagement.json"

jest.mock("@/hooks/sandbox/use-sandbox-snapshots", () => ({ useSandboxSnapshots: jest.fn() }))
const create = jest.fn().mockResolvedValue(undefined)
const restore = jest.fn().mockResolvedValue(undefined)
const remove = jest.fn().mockResolvedValue(undefined)
const context: SandboxPreviewContext = {
  targets: [
    {
      workspaceId: "w",
      provider: "local",
      containerId: "c",
      executionRoot: "/repo",
      ports: [],
      workspaceState: "active",
      portLease: null,
    },
  ],
  snapshotUsageBytes: 500,
  sandboxSnapshotBudgetBytes: 1000,
}
const onChanged = jest.fn().mockResolvedValue(undefined)
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useSandboxSnapshots).mockReturnValue({
    snapshots: [],
    loading: false,
    busy: false,
    error: null,
    forked: null,
    refresh: jest.fn(),
    create,
    pin: jest.fn(),
    remove,
    fork: jest.fn(),
    restore,
  })
})

it("creates a snapshot without forwarded ports and preserves explicit exclusions", async () => {
  render(
    <SandboxSnapshotsPanel projectId="p" context={context} workspaces={[]} onChanged={onChanged} />
  )
  fireEvent.change(screen.getByLabelText(en.snapshots.exclusions), {
    target: { value: "ignored/private\ngenerated/cache" },
  })
  fireEvent.click(screen.getByRole("button", { name: en.snapshots.create }))
  expect(create).toHaveBeenCalledWith({
    workspaceId: "w",
    provider: "local",
    containerId: "c",
    exclusions: ["ignored/private", "generated/cache"],
  })
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
})

it("shows authoritative usage and refuses creation over budget", () => {
  render(
    <SandboxSnapshotsPanel
      projectId="p"
      context={{ ...context, snapshotUsageBytes: 1000 }}
      workspaces={[]}
      onChanged={onChanged}
    />
  )
  expect(screen.getByRole("button", { name: en.snapshots.create })).toBeDisabled()
  expect(screen.getByText(en.snapshots.errors.budget)).toBeInTheDocument()
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-label", en.snapshots.budgetLabel)
})

it("requires a restore-capable archived target and a second click to delete", async () => {
  jest.mocked(useSandboxSnapshots).mockReturnValue({
    ...jest.mocked(useSandboxSnapshots)("p"),
    snapshots: [
      {
        snapshotId: "s",
        workspaceRoot: "/repo",
        phase: "ready",
        createdAt: 1,
        imageBytes: 10,
        pinned: true,
        exclusions: [],
      } as never,
    ],
  })
  render(
    <SandboxSnapshotsPanel
      projectId="p"
      context={context}
      workspaces={[
        {
          projectId: "p",
          workspaceId: "a",
          state: "archived",
          allowedActions: ["restore"],
          path: "/archived",
        } as never,
        {
          workspaceId: "live",
          state: "active",
          allowedActions: ["restore"],
          path: "/live",
        } as never,
      ]}
      onChanged={onChanged}
    />
  )
  expect(screen.queryByRole("button", { name: en.snapshots.restore })).not.toBeInTheDocument()
  expect(screen.queryByRole("option", { hidden: true, name: "/live" })).not.toBeInTheDocument()
  await selectOption(screen.getByLabelText(en.snapshots.restoreTarget), "a")
  fireEvent.click(screen.getByRole("button", { name: en.snapshots.restore }))
  expect(restore).toHaveBeenCalledWith("s", "a")
  fireEvent.click(screen.getByRole("button", { name: en.snapshots.delete }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: en.snapshots.confirmDelete }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith("s"))
  expect(screen.getByRole("button", { name: en.snapshots.unpin })).toBeInTheDocument()
})

it("provides matching locale keys for snapshot and preview UI", () => {
  const keys = (object: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(object).flatMap(([key, value]) =>
      typeof value === "object" && value
        ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`]
    )
  expect(keys(en).sort()).toEqual(keys(zh).sort())
})

it("treats a tombstoned list as empty", () => {
  jest.mocked(useSandboxSnapshots).mockReturnValue({
    ...jest.mocked(useSandboxSnapshots)("p"),
    snapshots: [{ snapshotId: "deleted", phase: "tombstoned" } as never],
  })
  render(
    <SandboxSnapshotsPanel projectId="p" context={context} workspaces={[]} onChanged={onChanged} />
  )
  expect(screen.getByText(en.snapshots.empty)).toBeInTheDocument()
})

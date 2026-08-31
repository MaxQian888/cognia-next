/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { error?: string }) =>
    values?.error ? `${key}:${values.error}` : key,
  // The row reports when an environment was last used. A relative time needs
  // no locale data to be asserted on, so the mock returns a stable marker.
  useFormatter: () => ({ relativeTime: () => "relative-time" }),
}))

const listMock = jest.fn()
const pinMock = jest.fn()
const archiveMock = jest.fn()
const restoreMock = jest.fn()
const permanentMock = jest.fn()
const adoptMock = jest.fn()
const adoptEnvironmentMock = jest.fn()
const deleteMock = jest.fn()
const createBranchMock = jest.fn()
const removeMock = jest.fn()
const pruneMock = jest.fn()
const openMock = jest.fn()

jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspaceEnvironments: (...args: unknown[]) => listMock(...args),
  pinManagedWorkspace: (...args: unknown[]) => pinMock(...args),
  archiveManagedWorkspace: (...args: unknown[]) => archiveMock(...args),
  restoreManagedWorkspace: (...args: unknown[]) => restoreMock(...args),
  makeManagedWorkspacePermanent: (...args: unknown[]) => permanentMock(...args),
  adoptManagedWorkspace: (...args: unknown[]) => adoptMock(...args),
  adoptWorkspaceEnvironment: (...args: unknown[]) => adoptEnvironmentMock(...args),
  deleteManagedWorkspace: (...args: unknown[]) => deleteMock(...args),
  createWorkspaceBranch: (...args: unknown[]) => createBranchMock(...args),
}))
jest.mock("@/lib/git/commands", () => ({
  gitWorktreeRemove: (...args: unknown[]) => removeMock(...args),
  gitWorktreePrune: (...args: unknown[]) => pruneMock(...args),
  runGitUserAction: (_command: string, operation: () => Promise<unknown>) => operation(),
}))
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (...args: unknown[]) => openMock(...args),
}))

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"
import { gitTargetFromRemote } from "@/lib/git/target"

import { WorkspaceEnvironmentList } from "./workspace-environment-list"

const managed: WorkspaceEnvironmentSummary = {
  environmentId: "ws-1",
  workspaceId: "ws-1",
  path: "/managed/ws-1",
  sourceRoot: "/repo",
  ownership: "managed",
  ownerType: "session",
  ownerRef: "session-1",
  state: "active",
  branch: null,
  head: "1111111",
  locked: true,
  lockReason: "cognia:ws-1",
  prunable: false,
  pruneReason: null,
  base: { kind: "workingState" },
  pinned: false,
  allowedActions: ["open", "pin", "makePermanent", "archive"],
}

const manual: WorkspaceEnvironmentSummary = {
  environmentId: "git:manual",
  workspaceId: null,
  path: "/work/feature-a",
  sourceRoot: "/repo",
  ownership: "manual",
  ownerType: null,
  ownerRef: null,
  state: null,
  branch: "feature/a",
  head: "2222222",
  locked: false,
  lockReason: null,
  prunable: false,
  pruneReason: null,
  base: null,
  pinned: false,
  allowedActions: ["open", "remove", "adopt"],
}

const prunableManual: WorkspaceEnvironmentSummary = {
  ...manual,
  environmentId: "git:prunable",
  path: "/work/stale",
  prunable: true,
  pruneReason: "gitdir file points to a missing directory",
  allowedActions: ["prune"],
}

beforeEach(() => {
  jest.clearAllMocks()
  listMock.mockResolvedValue([managed, manual, prunableManual])
  pinMock.mockResolvedValue(undefined)
  archiveMock.mockResolvedValue(undefined)
  restoreMock.mockResolvedValue(undefined)
  permanentMock.mockResolvedValue(undefined)
  adoptMock.mockResolvedValue(undefined)
  adoptEnvironmentMock.mockResolvedValue(undefined)
  deleteMock.mockResolvedValue(undefined)
  createBranchMock.mockResolvedValue({ workspaceId: "ws-1", branch: "feature/review" })
  removeMock.mockResolvedValue(undefined)
  pruneMock.mockResolvedValue(undefined)
})

it("renders the canonical manual and managed inventory in sheet presentation", async () => {
  render(<WorkspaceEnvironmentList presentation="sheet" rootDir="/repo" />)

  expect(await screen.findByTestId("workspace-environment-ws-1")).toHaveTextContent("/managed/ws-1")
  expect(screen.getByTestId("workspace-environment-git:manual")).toHaveTextContent(
    "/work/feature-a"
  )
  expect(screen.getByText("ownership.managed")).toBeInTheDocument()
  expect(screen.getAllByText("ownership.manual")).toHaveLength(2)
  expect(screen.getByText("ownerTypes.session · session-1")).toBeInTheDocument()
  expect(screen.getByText("locked")).toBeInTheDocument()
  expect(screen.getByText("prunable")).toBeInTheDocument()
  expect(listMock).toHaveBeenCalledWith("/repo")
})

it("executes only managed actions authorized by the canonical row", async () => {
  listMock.mockResolvedValue([managed])
  render(<WorkspaceEnvironmentList />)
  await screen.findByTestId("workspace-environment-ws-1")

  fireEvent.click(screen.getByRole("button", { name: "pin" }))
  await waitFor(() => expect(pinMock).toHaveBeenCalledWith("ws-1", true))
  expect(screen.queryByRole("button", { name: "restore" })).not.toBeInTheDocument()
})

it("requires confirmation and revalidates the server action before manual removal", async () => {
  listMock.mockResolvedValue([manual])
  const user = userEvent.setup()
  render(<WorkspaceEnvironmentList rootDir="/repo" />)

  await user.click(await screen.findByRole("button", { name: "remove" }))
  expect(removeMock).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "confirmRemove" }))

  await waitFor(() =>
    expect(removeMock).toHaveBeenCalledWith("/repo", "/work/feature-a", false, undefined, {
      source: "worktree-panel",
      ownerType: "user",
      reason: "user",
    })
  )
  expect(listMock).toHaveBeenCalledTimes(3)
})

it("supports force removal with branch deletion and the canonical source root", async () => {
  listMock.mockResolvedValue([manual])
  const user = userEvent.setup()
  render(<WorkspaceEnvironmentList />)

  await user.click(await screen.findByRole("button", { name: "remove" }))
  const options = screen.getAllByRole("checkbox")
  await user.click(options[0])
  await user.click(options[1])
  await user.click(screen.getByRole("button", { name: "confirmRemove" }))

  await waitFor(() =>
    expect(removeMock).toHaveBeenCalledWith("/repo", "/work/feature-a", true, "feature/a", {
      source: "worktree-panel",
      ownerType: "user",
      reason: "user",
    })
  )
})

it("blocks removal when the refreshed canonical row no longer allows it", async () => {
  listMock
    .mockResolvedValueOnce([manual])
    .mockResolvedValueOnce([
      { ...manual, ownership: "imported", workspaceId: "ws-imported", allowedActions: ["adopt"] },
    ])
  const user = userEvent.setup()
  render(<WorkspaceEnvironmentList rootDir="/repo" />)

  await user.click(await screen.findByRole("button", { name: "remove" }))
  await user.click(screen.getByRole("button", { name: "confirmRemove" }))

  await waitFor(() => expect(removeMock).not.toHaveBeenCalled())
  expect(await screen.findByRole("alert")).toHaveTextContent("loadError:registryProtected")
})

it("opens and prunes a manual environment only when those actions are allowed", async () => {
  listMock.mockResolvedValue([manual, prunableManual])
  const user = userEvent.setup()
  render(<WorkspaceEnvironmentList rootDir="/repo" showPrune />)

  await user.click(await screen.findByRole("button", { name: "open" }))
  expect(openMock).toHaveBeenCalledWith("/work/feature-a")
  await user.click(screen.getByRole("button", { name: "prune" }))
  await waitFor(() => expect(pruneMock).toHaveBeenCalledWith("/repo"))
})

it("archives and restores according to refreshed canonical actions", async () => {
  listMock
    .mockResolvedValueOnce([managed])
    .mockResolvedValueOnce([
      { ...managed, state: "archived", allowedActions: ["restore", "delete", "pin"] },
    ])
    .mockResolvedValueOnce([managed])
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "archive" }))
  await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("ws-1"))
  fireEvent.click(await screen.findByRole("button", { name: "restore" }))
  await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("ws-1"))
})

it("requires confirmation before deleting an archived environment", async () => {
  listMock.mockResolvedValueOnce([
    { ...managed, state: "archived", allowedActions: ["restore", "delete"] },
  ])
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "delete" }))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "confirmDelete" }))

  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("ws-1"))
})

it("requires an explicit Adopt action for an imported environment", async () => {
  listMock
    .mockResolvedValueOnce([
      { ...managed, ownership: "imported", state: "active", allowedActions: ["open", "adopt"] },
    ])
    .mockResolvedValueOnce([managed])
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "adopt" }))

  await waitFor(() => expect(adoptMock).toHaveBeenCalledWith("ws-1"))
  expect(await screen.findByText("ownership.managed")).toBeInTheDocument()
})

it("runs make-permanent and unpin actions only when advertised", async () => {
  const pinned = {
    ...managed,
    pinned: true,
    allowedActions: ["pin", "makePermanent"] as WorkspaceEnvironmentSummary["allowedActions"],
  }
  listMock.mockResolvedValue([pinned])
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "unpin" }))
  await waitFor(() => expect(pinMock).toHaveBeenCalledWith("ws-1", false))
  fireEvent.click(screen.getByRole("button", { name: "makePermanent" }))
  await waitFor(() => expect(permanentMock).toHaveBeenCalledWith("ws-1"))
})

it("creates a branch only when the server advertises the action", async () => {
  listMock.mockResolvedValueOnce([
    {
      ...managed,
      allowedActions: ["open", "createBranchHere"] as WorkspaceEnvironmentSummary["allowedActions"],
    },
  ])
  const user = userEvent.setup()
  render(<WorkspaceEnvironmentList />)

  await user.click(await screen.findByRole("button", { name: "createBranch" }))
  await user.type(screen.getByRole("textbox", { name: "branchName" }), "feature/review")
  await user.click(screen.getByRole("button", { name: "confirmCreateBranch" }))

  await waitFor(() => expect(createBranchMock).toHaveBeenCalledWith("ws-1", "feature/review"))
})

it("adopts a manual worktree through its canonical environment identity", async () => {
  listMock.mockResolvedValueOnce([manual]).mockResolvedValueOnce([managed])
  render(<WorkspaceEnvironmentList rootDir="/repo" />)

  fireEvent.click(await screen.findByRole("button", { name: "adopt" }))

  await waitFor(() =>
    expect(adoptEnvironmentMock).toHaveBeenCalledWith("git:manual", "/repo", "/work/feature-a")
  )
})

it("renders an actionable load error", async () => {
  listMock.mockRejectedValueOnce(new Error("host unavailable"))
  render(<WorkspaceEnvironmentList />)

  expect(await screen.findByRole("alert")).toHaveTextContent("loadError:host unavailable")
})

it("reports refresh and managed-action failures through the shared error boundary", async () => {
  archiveMock.mockRejectedValueOnce({ detail: "archive blocked" })
  listMock.mockResolvedValueOnce([managed]).mockRejectedValueOnce("host offline")
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "archive" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("loadError:archive blocked")
  fireEvent.click(screen.getByRole("button", { name: "refresh" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("loadError:host offline")
})

it("renders the empty state and hides local open actions for a remote inventory", async () => {
  listMock.mockResolvedValueOnce([])
  const { rerender } = render(<WorkspaceEnvironmentList />)
  expect(await screen.findByText("emptyTitle")).toBeInTheDocument()

  listMock.mockResolvedValueOnce([manual])
  rerender(
    <WorkspaceEnvironmentList rootDir={gitTargetFromRemote("workspace", "repo")} refreshKey={1} />
  )
  await screen.findByTestId("workspace-environment-git:manual")
  expect(screen.queryByRole("button", { name: "open" })).not.toBeInTheDocument()
})

it("renders exceptional badges even when the host provides no reason text", async () => {
  listMock.mockResolvedValueOnce([
    { ...managed, lockReason: null, prunable: true, pruneReason: null },
  ])
  render(<WorkspaceEnvironmentList />)

  expect(await screen.findByText("locked")).toBeInTheDocument()
  expect(screen.getByText("prunable")).toBeInTheDocument()
})

describe("WorkspaceEnvironmentList — workspace scoping", () => {
  it("lists only the rows this workspace owns, and offers the rest", async () => {
    // Unscoped, a laptop with several checked-out projects reads as "this
    // workspace owns all of these".
    listMock.mockResolvedValue([
      { ...managed, environmentId: "mine", workspaceId: "mine", projectId: "project-a" },
      { ...managed, environmentId: "theirs", workspaceId: "theirs", projectId: "project-b" },
      { ...manual, environmentId: "unclaimed" },
    ])
    render(<WorkspaceEnvironmentList projectId="project-a" />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-mine")).toBeInTheDocument()
    )
    expect(screen.queryByTestId("workspace-environment-theirs")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-environment-unclaimed")).not.toBeInTheDocument()

    // A worktree no project claims is exactly what the user needs in order to
    // reclaim it, so it stays one click away rather than hidden.
    fireEvent.click(screen.getByTestId("workspace-environments-scope-toggle"))
    expect(screen.getByTestId("workspace-environment-theirs")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-environment-unclaimed")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-environments-scope-toggle"))
    expect(screen.queryByTestId("workspace-environment-theirs")).not.toBeInTheDocument()
  })

  it("stays machine-wide with no workspace scope, and offers no toggle", async () => {
    listMock.mockResolvedValue([
      { ...managed, environmentId: "mine", workspaceId: "mine", projectId: "project-a" },
      { ...manual, environmentId: "unclaimed" },
    ])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-mine")).toBeInTheDocument()
    )
    expect(screen.getByTestId("workspace-environment-unclaimed")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-environments-scope-toggle")).not.toBeInTheDocument()
  })

  /**
   * `branch` used to reach the screen only as a fallback in the Base column,
   * so the rows that HAD a branch were exactly the ones that did not show one.
   * `head` was projected by the host and rendered nowhere at all.
   */
  it("names the branch and the short HEAD the worktree is on", async () => {
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-git:manual")).toBeInTheDocument()
    )
    const row = screen.getByTestId("workspace-environment-git:manual")
    expect(within(row).getByText("feature/a")).toBeInTheDocument()
    expect(within(row).getByText("2222222")).toBeInTheDocument()
  })

  it("shortens a full-length HEAD to seven characters", async () => {
    listMock.mockResolvedValue([{ ...manual, head: "0123456789abcdef0123456789abcdef01234567" }])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-git:manual")).toBeInTheDocument()
    )
    expect(screen.getByText("0123456")).toBeInTheDocument()
  })

  /**
   * Both facts live on the host's Registry row and were dropped by the
   * projection, which left this list unable to say what is taking up the disk
   * or whether anything still uses a directory.
   */
  it("reports the footprint the host now sends", async () => {
    listMock.mockResolvedValue([{ ...managed, sizeBytes: 1024 * 1024 * 3, lastUsedAt: 1_700_000 }])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-ws-1")).toBeInTheDocument()
    )
    const row = screen.getByTestId("workspace-environment-ws-1")
    expect(within(row).getByText("3 MB")).toBeInTheDocument()
    expect(within(row).getByText("relative-time")).toBeInTheDocument()
  })

  /**
   * A missing size means "the Registry has not measured this", never "empty",
   * so the row must not render a confident 0 B.
   */
  it("says a directory was never used rather than inventing a footprint", async () => {
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-git:manual")).toBeInTheDocument()
    )
    const row = screen.getByTestId("workspace-environment-git:manual")
    expect(within(row).getByText("neverUsed")).toBeInTheDocument()
    expect(within(row).queryByText("0 B")).not.toBeInTheDocument()
  })

  /**
   * The list was one flat run in host order, so a locked or prunable row read
   * the same as a healthy one until the fourth column.
   */
  it("puts the rows that need a decision first", async () => {
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-band-attention")).toBeInTheDocument()
    )
    const bands = screen.getAllByTestId(/^workspace-environment-band-/)
    expect(bands[0]).toHaveAttribute("data-testid", "workspace-environment-band-attention")
    // `managed` is locked and `prunableManual` is prunable; `manual` is neither.
    const attention = within(bands[0] as HTMLElement).getByText(/^2$/)
    expect(attention).toBeInTheDocument()
  })

  it("drops a band entirely rather than showing an empty heading", async () => {
    listMock.mockResolvedValue([manual])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-band-active")).toBeInTheDocument()
    )
    expect(screen.queryByTestId("workspace-environment-band-attention")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-environment-band-dormant")).not.toBeInTheDocument()
  })

  /**
   * A worktree exists because something asked for it. Naming that something
   * and then leaving the reader to find it by hand is the gap this closes.
   */
  it("links a squad-owned environment to the squad that owns it", async () => {
    listMock.mockResolvedValue([{ ...managed, ownerType: "team", ownerRef: "squad-7" }])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-ws-1")).toBeInTheDocument()
    )
    const link = screen.getByRole("link", { name: /squad-7/ })
    expect(link).toHaveAttribute("href", "/squads?id=squad-7")
  })

  /**
   * A `user` row has nowhere to go, so it stays plain text instead of a
   * control that does nothing.
   */
  it("leaves an owner with no destination as text", async () => {
    listMock.mockResolvedValue([{ ...managed, ownerType: "user", ownerRef: "someone" }])
    render(<WorkspaceEnvironmentList />)

    await waitFor(() =>
      expect(screen.getByTestId("workspace-environment-ws-1")).toBeInTheDocument()
    )
    expect(screen.queryByRole("link", { name: /someone/ })).not.toBeInTheDocument()
    expect(screen.getByText(/someone/)).toBeInTheDocument()
  })
})

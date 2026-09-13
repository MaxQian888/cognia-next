/** @jest-environment jsdom */

const mockNow = new Date("2026-09-09T08:00:00Z")
const mockRelativeTime = jest.fn(() => "relative-time")

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { error?: string }) =>
    values?.error ? `${key}:${values.error}` : key,
  // The row reports when an environment was last used. A relative time needs
  // no locale data to be asserted on, so the mock returns a stable marker.
  useFormatter: () => ({ relativeTime: mockRelativeTime }),
  useNow: () => mockNow,
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

/**
 * Radix portals don't render into jsdom — flatten the row overflow menu.
 *
 * The row's secondary actions moved out of nine icon-only ghost buttons and
 * into one labelled menu (two pairs of them shared a glyph: `Trash2` meant both
 * "delete the archived environment" and "remove the worktree"). Flattening the
 * menu keeps every assertion below querying the action by its accessible name,
 * which is what those assertions were always about. The menu's own structure —
 * that there IS a trigger, and that the destructive half is separated — is
 * pinned by its own case rather than by every action case.
 */
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="row-action-separator" />,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"
import { gitTargetFromRemote } from "@/lib/git/target"

import { bandOf, pulseOf, WorkspaceEnvironmentList } from "./workspace-environment-list"

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

describe("pulseOf", () => {
  it("separates a broken worktree from one that is merely reclaimable", () => {
    // Both land in the attention band, and the band alone throws the
    // distinction away: one is a failure, the other is an offer.
    expect(pulseOf({ ...managed, state: "conflict" })).toBe("conflict")
    expect(pulseOf(prunableManual)).toBe("attention")
    expect(pulseOf({ ...manual, locked: true })).toBe("attention")
  })

  it("calls a worktree mid-provision provisioning, not merely active", () => {
    expect(pulseOf({ ...managed, locked: false, state: "provisioning" })).toBe("provisioning")
  })

  it("reports a healthy row as active and a shelved one as dormant", () => {
    expect(pulseOf({ ...managed, locked: false })).toBe("active")
    expect(pulseOf({ ...managed, locked: false, state: "archived" })).toBe("dormant")
    expect(pulseOf({ ...managed, locked: false, state: "removed" })).toBe("dormant")
  })

  it("never disagrees with the band the row was filed under", () => {
    const rows: WorkspaceEnvironmentSummary[] = [
      managed,
      manual,
      prunableManual,
      { ...managed, locked: false, state: "conflict" },
      { ...managed, locked: false, state: "archived" },
      { ...managed, locked: false, state: "provisioning" },
    ]
    for (const row of rows) {
      const pulse = pulseOf(row)
      if (pulse === "conflict" || pulse === "attention") continue
      if (pulse === "dormant") expect(bandOf(row)).toBe("dormant")
      else expect(bandOf(row)).toBe("active")
    }
  })
})

describe("row pulse", () => {
  it("leads every row with a named state a screen reader can read", async () => {
    render(<WorkspaceEnvironmentList rootDir="/repo" />)
    const dot = await screen.findByTestId("workspace-environment-pulse-git:manual")
    expect(dot).toHaveAttribute("data-pulse", "active")
    expect(dot).toHaveAttribute("aria-label", "pulses.active")
  })

  it("marks a reclaimable worktree without relying on colour alone", async () => {
    render(<WorkspaceEnvironmentList rootDir="/repo" />)
    const dot = await screen.findByTestId("workspace-environment-pulse-git:prunable")
    expect(dot).toHaveAttribute("data-pulse", "attention")
    expect(dot).toHaveAttribute("aria-label", "pulses.attention")
  })
})

describe("row overflow menu", () => {
  it("gives every row one labelled menu instead of a bank of icon buttons", async () => {
    listMock.mockResolvedValue([manual])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:manual")
    // Open stays inline — it is the row's primary verb and needs no label to
    // be guessed at. Everything else is behind the one trigger.
    expect(screen.getByRole("button", { name: "open" })).toBeInTheDocument()
    expect(screen.getByTestId("workspace-environment-actions-git:manual")).toHaveAttribute(
      "aria-label",
      "rowActions"
    )
  })

  it("separates the destructive half of the menu from the rest", async () => {
    listMock.mockResolvedValue([manual])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:manual")
    // `adopt` then `remove`: one separator, drawn only because both halves exist.
    expect(screen.getAllByTestId("row-action-separator")).toHaveLength(1)
  })

  it("renders no trigger at all for a row that offers nothing but open", async () => {
    listMock.mockResolvedValue([{ ...manual, allowedActions: ["open"] }])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:manual")
    expect(screen.queryByTestId("workspace-environment-actions-git:manual")).not.toBeInTheDocument()
  })
})

describe("WorkspaceEnvironmentList — filtering", () => {
  /** Six rows: the threshold at which the filter field is worth its space. */
  const many = Array.from({ length: 6 }, (_, index) => ({
    ...manual,
    environmentId: `git:${index}`,
    path: index < 3 ? `/work/alpha-${index}` : `/work/beta-${index}`,
    branch: index < 3 ? `feature/alpha-${index}` : `fix/beta-${index}`,
  }))

  it("withholds the filter field until there is a list worth filtering", async () => {
    listMock.mockResolvedValue([manual])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:manual")
    expect(screen.queryByTestId("workspace-environments-search")).not.toBeInTheDocument()
  })

  it("narrows the list by path and by branch", async () => {
    listMock.mockResolvedValue(many)
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:0")
    fireEvent.change(screen.getByTestId("workspace-environments-search"), {
      target: { value: "beta" },
    })
    expect(screen.queryByTestId("workspace-environment-git:0")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-environment-git:5")).toBeInTheDocument()

    // The branch is what the reader usually remembers, not the generated path.
    fireEvent.change(screen.getByTestId("workspace-environments-search"), {
      target: { value: "feature/alpha-1" },
    })
    expect(screen.getByTestId("workspace-environment-git:1")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-environment-git:2")).not.toBeInTheDocument()
  })

  it("answers an over-narrow filter with the way back, not with 'create one'", async () => {
    listMock.mockResolvedValue(many)
    render(<WorkspaceEnvironmentList rootDir="/repo" showCreate />)

    await screen.findByTestId("workspace-environment-git:0")
    fireEvent.change(screen.getByTestId("workspace-environments-search"), {
      target: { value: "nothing-matches-this" },
    })

    expect(screen.getByText("noMatchesTitle")).toBeInTheDocument()
    expect(screen.queryByText("emptyTitle")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-environments-clear-filters"))
    expect(screen.getByTestId("workspace-environment-git:0")).toBeInTheDocument()
  })

  it("offers a band chip per band and shows only that band when picked", async () => {
    // `managed` is locked (attention), `manual` is neither (active).
    listMock.mockResolvedValue([managed, manual])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-ws-1")
    fireEvent.click(screen.getByTestId("workspace-environments-filter-active"))
    expect(screen.queryByTestId("workspace-environment-ws-1")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-environment-git:manual")).toBeInTheDocument()
  })

  it("hides the band chips when every row is in one band", async () => {
    listMock.mockResolvedValue([manual])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-git:manual")
    expect(screen.queryByTestId("workspace-environments-band-filter")).not.toBeInTheDocument()
  })

  /**
   * A chip selection outlives the rows it described. Left alone, narrowing the
   * text query until the chosen band is gone leaves the reader staring at an
   * empty list they never asked for, with a chip selected that no longer
   * exists to un-select.
   */
  it("falls back to every band when the chosen one is filtered away", async () => {
    listMock.mockResolvedValue([managed, ...many])
    render(<WorkspaceEnvironmentList rootDir="/repo" />)

    await screen.findByTestId("workspace-environment-ws-1")
    fireEvent.click(screen.getByTestId("workspace-environments-filter-attention"))
    expect(screen.queryByTestId("workspace-environment-git:0")).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId("workspace-environments-search"), {
      target: { value: "alpha" },
    })
    expect(screen.getByTestId("workspace-environment-git:0")).toBeInTheDocument()
  })
})

describe("WorkspaceEnvironmentList — empty state", () => {
  it("offers creation from the empty state rather than describing it", async () => {
    listMock.mockResolvedValue([])
    render(<WorkspaceEnvironmentList rootDir="/repo" showCreate />)

    expect(await screen.findByText("emptyTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-environments-empty-create"))
    expect(screen.getByTestId("workspace-environments-create")).toBeInTheDocument()
  })

  it("describes the empty inventory without an offer it cannot honour", async () => {
    listMock.mockResolvedValue([])
    render(<WorkspaceEnvironmentList />)

    expect(await screen.findByText("emptyTitle")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-environments-empty-create")).not.toBeInTheDocument()
  })
})

it("formats last use against an explicit shared clock", async () => {
  const lastUsedAt = mockNow.getTime() - 60_000
  listMock.mockResolvedValue([{ ...managed, lastUsedAt }])
  render(<WorkspaceEnvironmentList presentation="sheet" rootDir="/repo" />)
  await screen.findByText("relative-time")
  expect(mockRelativeTime).toHaveBeenCalledWith(new Date(lastUsedAt), mockNow)
})

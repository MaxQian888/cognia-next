/** @jest-environment jsdom */
import { WebStatusProvider } from "@/components/shell/web-status"

jest.mock("@/components/shell/use-bar-layout", () => ({
  useBarLayout: () => ({
    resolved: {
      zones: {
        start: [{ id: "connectivity" }],
        center: [{ id: "runStatus" }],
        end: [],
      },
    },
  }),
}))
jest.mock("@/components/desktop/status-bar-zone", () => ({
  StatusBarZone: ({ items }: { items: { id: string }[] }) =>
    items.map(({ id }) => <span key={id} data-testid={`segment-${id}`} />),
}))
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"

import { ContextBar } from "./context-bar"
import { useImNotifyStore } from "@/stores/chat/im-notify-store"
import type { NewChatExecutionSelection } from "@/components/chat/new-chat-execution-picker"
import type { Project } from "@/types"

const gitBranches = jest.fn()
const gitRefs = jest.fn()
const gitCheckoutBranch = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitBranches: (...a: unknown[]) => gitBranches(...a),
  gitRefs: (...a: unknown[]) => gitRefs(...a),
  gitCheckoutBranch: (...a: unknown[]) => gitCheckoutBranch(...a),
}))

const listProjectEnvironments = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  listProjectEnvironments: (...a: unknown[]) => listProjectEnvironments(...a),
}))

const convToArray = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ connectorConversationStates: { toArray: convToArray } }),
}))
const listAdapterInstances = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: () => listAdapterInstances(),
}))

const EXEC: NewChatExecutionSelection = {
  location: "managedWorktree",
  base: { kind: "workingState" },
}

const PROJECT = {
  id: "p1",
  roots: [{ id: "r1", path: "/repo", isPrimary: true }],
} as unknown as Project

const MULTI_ROOT = {
  id: "p1",
  roots: [
    { id: "r1", path: "/repo/app", isPrimary: true, label: "app" },
    { id: "r2", path: "/repo/api", label: "api" },
  ],
} as unknown as Project

function Harness({
  project = PROJECT,
  initial = EXEC,
}: {
  project?: Project
  initial?: NewChatExecutionSelection
}) {
  const [execution, setExecution] = useState(initial)
  return <ContextBar execution={execution} onExecutionChange={setExecution} project={project} />
}

async function renderBar(props?: Parameters<typeof Harness>[0]) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(<Harness {...props} />)
  })
  return result
}

const branch = (name: string, isCurrent = false) => ({
  name,
  isCurrent,
  isRemote: false,
})

const env = (id: string, name: string) =>
  ({
    id,
    projectId: "p1",
    name,
    isEnabled: true,
    setupScript: { default: "echo ok" },
    actions: [],
    variables: {},
    keyringReferences: [],
    updatedAt: 0,
    createdAt: 0,
  }) as never

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  gitBranches.mockResolvedValue([branch("main", true), branch("dev")])
  gitRefs.mockResolvedValue([
    { name: "v1.0", kind: "tag" },
    { name: "origin/main", kind: "remote" },
  ])
  gitCheckoutBranch.mockResolvedValue(undefined)
  listProjectEnvironments.mockResolvedValue([])
  convToArray.mockResolvedValue([])
  listAdapterInstances.mockResolvedValue([])
  useImNotifyStore.setState({
    enabled: false,
    conversationKey: null,
    events: { done: true, error: true, attention: false },
    armed: {},
  })
})

describe("ContextBar", () => {
  it("renders repository · worktree tokens fused on the composer's top edge", async () => {
    await renderBar()
    const bar = screen.getByTestId("context-bar")
    expect(within(bar).getByTestId("ctxbar-repo")).toBeInTheDocument()
    expect(within(bar).getByTestId("ctxbar-worktree")).toBeInTheDocument()
    expect(within(bar).getByTestId("ctxbar-notify")).toBeInTheDocument()
    expect(within(bar).getByTestId("ctxbar-more")).toBeInTheDocument()
    // Repository sits left of the worktree token.
    const repo = within(bar).getByTestId("ctxbar-repo")
    const worktree = within(bar).getByTestId("ctxbar-worktree")
    expect(repo.compareDocumentPosition(worktree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("hides the environment token when the workspace defines none", async () => {
    await renderBar()
    expect(screen.queryByTestId("ctxbar-env")).not.toBeInTheDocument()
  })

  it("lists project environments and writes the pick into the selection", async () => {
    listProjectEnvironments.mockResolvedValue([env("e1", "Full dev"), env("e2", "Minimal")])
    await renderBar()
    fireEvent.click(await screen.findByTestId("ctxbar-env"))
    fireEvent.click(await screen.findByText("Minimal"))
    expect(screen.getByTestId("ctxbar-env")).toHaveTextContent("Minimal")
  })

  it("maps the env token's explicit none to an empty environmentId", async () => {
    listProjectEnvironments.mockResolvedValue([env("e1", "Full dev")])
    await renderBar()
    fireEvent.click(await screen.findByTestId("ctxbar-env"))
    fireEvent.click(await screen.findByText("No environment"))
    const hidden = screen.getByTestId("ctxbar-env")
    expect(hidden).toHaveTextContent("No environment")
  })

  it("keeps a stale environment pick visible even when no enabled envs remain", async () => {
    // The env the selection named was deleted or disabled — the token must
    // stay rendered so the stale choice is correctable rather than hiding it
    // while the dead id still rides into session creation.
    listProjectEnvironments.mockResolvedValue([])
    await renderBar({ initial: { ...EXEC, environmentId: "gone-env" } })
    const token = screen.getByTestId("ctxbar-env")
    fireEvent.click(token)
    // The stale id surfaces as a disabled option...
    const stale = await screen.findByRole("option", { name: "gone-env" })
    expect(stale).toHaveAttribute("aria-disabled", "true")
    // ...and the user can still correct it back to an explicit none, at
    // which point nothing remains to pick and the token retires entirely.
    fireEvent.click(await screen.findByText("No environment"))
    expect(screen.queryByTestId("ctxbar-env")).not.toBeInTheDocument()
  })

  it("lets a multi-root workspace pick the repository root", async () => {
    await renderBar({ project: MULTI_ROOT })
    fireEvent.click(screen.getByTestId("ctxbar-repo"))
    const panel = await screen.findByTestId("ctxbar-repo-panel")
    // Switching roots refires the git fetch — keep the resolution in act.
    await act(async () => {
      fireEvent.click(within(panel).getByText("api"))
    })
    expect(screen.getByTestId("ctxbar-repo")).toHaveTextContent("api")
    // The selected root owns the git queries.
    expect(gitBranches).toHaveBeenLastCalledWith("/repo/api")
  })

  it("degrades the repo token to a label for a single root in worktree mode", async () => {
    await renderBar()
    const repo = screen.getByTestId("ctxbar-repo")
    expect(repo.tagName).toBe("SPAN")
    expect(repo).toHaveTextContent("repo")
  })

  it("checks out a real branch from the repo panel in local mode", async () => {
    await renderBar({ initial: { location: "local", base: { kind: "localHead" } } })
    fireEvent.click(screen.getByTestId("ctxbar-repo"))
    const panel = await screen.findByTestId("ctxbar-repo-panel")
    // The checkout → refetch chain resolves asynchronously — keep it in act.
    await act(async () => {
      fireEvent.click(within(panel).getByText("dev"))
    })
    expect(gitCheckoutBranch).toHaveBeenCalledWith("/repo", "dev")
  })

  it("worktree off maps to local execution", async () => {
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    fireEvent.click(await screen.findByTestId("ctxbar-worktree-off"))
    // Local mode unlocks the branch section inside the repo popover.
    fireEvent.click(screen.getByTestId("ctxbar-repo"))
    const panel = await screen.findByTestId("ctxbar-repo-panel")
    expect(within(panel).getByText("dev")).toBeInTheDocument()
  })

  it("worktree auto clears any manual name", async () => {
    await renderBar({
      initial: { location: "managedWorktree", worktreeName: "feat/x", base: { kind: "localHead" } },
    })
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    fireEvent.click(await screen.findByTestId("ctxbar-worktree-auto"))
    // The name input unmounts the moment the mode flips.
    expect(screen.queryByTestId("ctxbar-worktree-name")).not.toBeInTheDocument()
  })

  it("worktree manual exposes the name input and stores the draft", async () => {
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    fireEvent.click(await screen.findByTestId("ctxbar-worktree-manual"))
    const input = await screen.findByTestId("ctxbar-worktree-name")
    fireEvent.change(input, { target: { value: "feat/login" } })
    // Reopen to read the trigger label — the draft shows on the token.
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("ctxbar-worktree")).toHaveTextContent("feat/login")
  })

  it("flags an invalid worktree name inside the panel", async () => {
    await renderBar({
      initial: { location: "managedWorktree", worktreeName: "", base: { kind: "localHead" } },
    })
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    const input = await screen.findByTestId("ctxbar-worktree-name")
    fireEvent.change(input, { target: { value: "bad name" } })
    expect(await screen.findByText("Not a valid branch name")).toBeInTheDocument()
  })

  it("flags a worktree name that collides with an existing branch", async () => {
    await renderBar({
      initial: { location: "managedWorktree", worktreeName: "", base: { kind: "localHead" } },
    })
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    const input = await screen.findByTestId("ctxbar-worktree-name")
    fireEvent.change(input, { target: { value: "dev" } })
    expect(await screen.findByText("A branch with this name already exists")).toBeInTheDocument()
  })

  it("keeps the base kind picker inside the worktree panel", async () => {
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    fireEvent.click(await screen.findByTestId("ctxbar-base"))
    fireEvent.click(await screen.findByText("Git ref"))
    expect(await screen.findByTestId("ctxbar-gitref")).toBeInTheDocument()
  })

  it("edits the pull-request base without accepting an invalid request number", async () => {
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-worktree"))
    fireEvent.click(await screen.findByTestId("ctxbar-base"))
    fireEvent.click(await screen.findByText("Pull request"))
    const repository = screen.getByRole("textbox", { name: "Repository" })
    fireEvent.change(repository, { target: { value: "owner/repo" } })
    expect(repository).toHaveValue("owner/repo")
    const number = screen.getByRole("spinbutton", { name: "Pull request number" })
    fireEvent.change(number, { target: { value: "12" } })
    expect(number).toHaveValue(12)
    fireEvent.change(number, { target: { value: "0" } })
    expect(number).toHaveValue(12)
    fireEvent.click(screen.getByTestId("ctxbar-base"))
    fireEvent.click(await screen.findByText("Local HEAD"))
    expect(screen.queryByRole("spinbutton")).toBeNull()
  })

  it("shows the rootless hint and keeps notify + overflow available", async () => {
    await renderBar({ project: { id: "p1", roots: [] } as unknown as Project })
    expect(screen.queryByTestId("ctxbar-repo")).not.toBeInTheDocument()
    expect(screen.getByTestId("ctxbar-managed-hint")).toHaveTextContent("Worktree")
    const seen: string[] = []
    const onReq = (e: Event) => seen.push((e as CustomEvent<{ kind: string }>).detail.kind)
    window.addEventListener("cognia:workspace-dialog:request", onReq)
    fireEvent.click(screen.getByTestId("ctxbar-open-folder"))
    window.removeEventListener("cognia:workspace-dialog:request", onReq)
    expect(seen).toEqual(["openFolder"])
    expect(screen.getByTestId("ctxbar-notify")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("ctxbar-more"))
    const panel = await screen.findByTestId("ctxbar-panel")
    expect(within(panel).getByText("IM notify")).toBeInTheDocument()
  })

  it("toggles IM notify into the persisted store", async () => {
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-notify"))
    expect(useImNotifyStore.getState().enabled).toBe(true)
  })

  // The icon element remounts on each state swap so its one-shot animation
  // re-fires: arming rings the bell, muting tilts it still.
  it("replays the bell's ring/mute animation classes on each toggle", async () => {
    await renderBar()
    const toggle = screen.getByTestId("ctxbar-notify")
    expect(toggle.querySelector("svg")).toHaveClass("im-bell-mute")
    fireEvent.click(toggle)
    expect(toggle.querySelector("svg")).toHaveClass("im-bell-ring")
    fireEvent.click(toggle)
    expect(toggle.querySelector("svg")).toHaveClass("im-bell-mute")
  })

  it("lists real bound conversations in the send-via picker", async () => {
    convToArray.mockResolvedValue([
      {
        conversationKey: "ck1",
        adapterId: "a1",
        deliveryReadiness: "all_messages_verified",
        deliveryTarget: {
          address: {
            conversationKey: "ck1",
            platform: "lark",
            adapterId: "a1",
            scopeKind: "private",
            containerId: "c",
          },
          conversationRef: {},
          refreshedAt: 0,
        },
      },
    ])
    listAdapterInstances.mockResolvedValue([
      { id: "a1", type: "lark", displayName: "Lark Bot", enabled: true },
    ])
    useImNotifyStore.setState({ enabled: true })
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-more"))
    fireEvent.click(await screen.findByTestId("ctxbar-notify-channel"))
    fireEvent.click(await screen.findByText(/Lark Bot/))
    expect(useImNotifyStore.getState().conversationKey).toBe("ck1")
  })

  it("shows the no-channels hint and disables send-via when nothing is bound", async () => {
    useImNotifyStore.setState({ enabled: true })
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-more"))
    expect(await screen.findByText(/No bound IM conversations yet/)).toBeInTheDocument()
    expect(screen.getByTestId("ctxbar-notify-channel")).toBeDisabled()
  })

  it("writes notify-when chips into the persisted event prefs", async () => {
    useImNotifyStore.setState({ enabled: true })
    await renderBar()
    fireEvent.click(screen.getByTestId("ctxbar-more"))
    fireEvent.click(await screen.findByRole("button", { name: "Needs input" }))
    expect(useImNotifyStore.getState().events.attention).toBe(true)
  })
})

it("mounts session status inside the context strip", async () => {
  await act(async () => {
    render(
      <WebStatusProvider enabled>
        <Harness />
      </WebStatusProvider>
    )
  })
  expect(screen.getByTestId("context-bar")).toContainElement(
    screen.getByTestId("segment-connectivity")
  )
  expect(screen.queryByTestId("segment-runStatus")).toBeNull()
})

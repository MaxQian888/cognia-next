/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Stack } from "@/lib/stack/model"
import type { RestackStackResult } from "@/lib/stack/restack"
import type { GitBranch, GitStackLayerState } from "@/types/git"

import { StackPanel } from "./stack-panel"

const STACK: Stack = {
  id: "stack:me/b",
  repositoryRoot: "/repos/app",
  trunk: "main",
  model: "branchPerLayer",
  layers: [
    { id: "me/a", branch: "me/a", title: "me/a", order: 0 },
    { id: "me/b", branch: "me/b", title: "me/b", order: 1 },
  ],
}

const BRANCHES: GitBranch[] = [
  { name: "main", isCurrent: false, isRemote: false, upstream: null, ahead: 0, behind: 0 },
  { name: "me/a", isCurrent: true, isRemote: false, upstream: null, ahead: 0, behind: 0 },
  { name: "me/b", isCurrent: false, isRemote: false, upstream: null, ahead: 0, behind: 0 },
  { name: "origin/main", isCurrent: false, isRemote: true, upstream: null, ahead: 0, behind: 0 },
]

function state(over: Partial<GitStackLayerState> & { branch: string }): GitStackLayerState {
  return {
    parent: null,
    head: "0".repeat(40),
    containsParent: true,
    checkedOutIn: null,
    ...over,
  }
}

const HEALTHY = [
  state({ branch: "me/a", parent: "main" }),
  state({ branch: "me/b", parent: "me/a" }),
]

function deps(over: Record<string, unknown> = {}) {
  return {
    discover: jest.fn(async () => [STACK]),
    validate: jest.fn(async () => HEALTHY),
    restack: jest.fn(async (): Promise<RestackStackResult> => ({
      status: "restacked",
      verdict: { ok: false, problems: [], remedy: "restack" },
      method: "replay",
      updates: [],
    })),
    setParent: jest.fn(async () => {}),
    ...over,
  }
}

function renderPanel(over: Record<string, unknown> = {}) {
  const injected = deps(over)
  render(
    <StackPanel
      open
      onOpenChange={() => {}}
      rootDir="/repos/app"
      branches={BRANCHES}
      deps={injected as never}
    />
  )
  return injected
}

describe("StackPanel", () => {
  it("lists the chain bottom first, with its trunk", async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("stack-stack:me/b")).toBeInTheDocument())
    const card = screen.getByTestId("stack-stack:me/b")
    expect(card).toHaveAttribute("data-ok", "true")
    expect(card).toHaveTextContent("on main")
    expect(card).toHaveTextContent("2 layers")
    const layers = card.querySelectorAll("li")
    expect(layers[0]).toHaveTextContent("me/a")
    expect(layers[1]).toHaveTextContent("me/b")
  })

  it("says a healthy stack is healthy rather than showing nothing", async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.getByText("Every layer sits on the one below it.")).toBeInTheDocument()
    )
    // Nothing to fix, so no button that would do nothing.
    expect(screen.queryByTestId("stack-restack-stack:me/b")).not.toBeInTheDocument()
  })

  it("names the broken layer and offers the restack that fixes it", async () => {
    renderPanel({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a", containsParent: false }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId("stack-problems-stack:me/b")).toBeInTheDocument())
    expect(screen.getByTestId("stack-problems-stack:me/b")).toHaveTextContent(
      "me/b no longer contains me/a"
    )
    expect(screen.getByText("A restack will fix this.")).toBeInTheDocument()
    expect(screen.getByTestId("stack-restack-stack:me/b")).toBeInTheDocument()
  })

  it("does not offer a restack for a problem a restack cannot fix", async () => {
    // Offering a button that cannot work teaches people the button is broken.
    renderPanel({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", head: null }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId("stack-problems-stack:me/b")).toBeInTheDocument())
    expect(screen.getByText("Push or create the missing branch first.")).toBeInTheDocument()
    expect(screen.queryByTestId("stack-restack-stack:me/b")).not.toBeInTheDocument()
  })

  it("shows where a layer is checked out, since that blocks moving it", async () => {
    renderPanel({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a", checkedOutIn: "/tmp/task-42" }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId("stack-stack:me/b")).toBeInTheDocument())
    expect(screen.getByText("checked out at /tmp/task-42")).toBeInTheDocument()
    expect(screen.getByText("Close the worktree holding that layer first.")).toBeInTheDocument()
  })

  it("runs a restack when asked", async () => {
    const injected = renderPanel({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a", containsParent: false }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId("stack-restack-stack:me/b")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("stack-restack-stack:me/b"))
    await waitFor(() => expect(injected.restack).toHaveBeenCalled())
  })

  it("records a parent from the form — the only way to create a stack here", async () => {
    const injected = renderPanel({ discover: jest.fn(async () => []) })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())

    await userEvent.click(screen.getByRole("combobox", { name: "Branch" }))
    await userEvent.click(await screen.findByRole("option", { name: "me/b" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Sits on" }))
    await userEvent.click(await screen.findByRole("option", { name: "me/a" }))
    await userEvent.click(screen.getByTestId("stack-record-parent"))

    await waitFor(() =>
      expect(injected.setParent).toHaveBeenCalledWith("/repos/app", "me/b", "me/a")
    )
  })

  it("offers only local branches — a remote ref cannot be a stack layer", async () => {
    renderPanel({ discover: jest.fn(async () => []) })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("combobox", { name: "Branch" }))
    expect(await screen.findByRole("option", { name: "me/a" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "origin/main" })).not.toBeInTheDocument()
  })

  it("explains itself when the repository has no stacks", async () => {
    renderPanel({ discover: jest.fn(async () => []) })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())
    expect(screen.getByTestId("stack-panel-empty")).toHaveTextContent("No stacks recorded")
  })
})

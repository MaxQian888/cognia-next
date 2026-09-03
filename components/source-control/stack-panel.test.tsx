/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createFakeForge } from "@/lib/stack/forge/fake"
import { mergeStack } from "@/lib/stack/merge"
import type { StackForge } from "@/lib/stack/forge-session"
import type { Stack } from "@/lib/stack/model"
import type { RestackStackResult } from "@/lib/stack/restack"
import type { GitBranch, GitStackLayerState, GitStackPushOutcome } from "@/types/git"

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
  {
    name: "main",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
  },
  {
    name: "me/a",
    isCurrent: true,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
  },
  {
    name: "me/b",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
  },
  {
    name: "origin/main",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
  },
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
    history: jest.fn(async () => [] as Array<[string, string]>),
    revert: jest.fn(async () => "0".repeat(40)),
    ...over,
  }
}

const PUSHED: GitStackPushOutcome = { pushed: ["me/a", "me/b"], forceIfIncludes: true }

function forgeDeps(over: Record<string, unknown> = {}) {
  const adapter = createFakeForge()
  const injected = {
    open: jest.fn(async (): Promise<StackForge> => ({
      status: "ready",
      repository: "acme/app",
      remote: "origin",
      adapter,
    })),
    push: jest.fn(async () => PUSHED),
    // `mergeStack` restacks and re-parents the layers above each merge, which
    // is real git. Its own deps seam is what a test drives it through.
    merge: ((input) =>
      mergeStack(input, {
        setParent: async () => {},
        restack: async () => ({
          status: "upToDate",
          verdict: { ok: true, problems: [], remedy: "none" },
        }),
      })) satisfies typeof mergeStack,
    ...over,
  }
  return { injected, adapter }
}

function renderPanel(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const injected = deps(over)
  render(
    <StackPanel
      open
      onOpenChange={() => {}}
      rootDir="/repos/app"
      branches={BRANCHES}
      deps={injected as never}
      identity={async () => ({ name: "Ada Lovelace", email: "ada@example.com" })}
      {...extra}
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

  it("pushes before it publishes, then links each layer's pull request", async () => {
    // A pull request for a branch the remote has never seen is rejected, and a
    // restacked-but-unpushed stack publishes the commits that were replaced.
    const { injected: forge } = forgeDeps()
    renderPanel({}, { forgeDeps: forge })
    await waitFor(() => expect(screen.getByTestId("stack-publish-stack:me/b")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("stack-publish-stack:me/b"))

    await waitFor(() => expect(screen.getByTestId("stack-pr-me/a")).toBeInTheDocument())
    expect(forge.push).toHaveBeenCalledWith("/repos/app", "origin", ["me/a", "me/b"])
    expect(screen.getByTestId("stack-pr-me/b")).toBeInTheDocument()
  })

  it("will not publish a stack that does not validate", async () => {
    // Publishing a broken stack opens pull requests containing each other's
    // diffs — the outcome the whole validator exists to prevent.
    const { injected: forge } = forgeDeps()
    renderPanel(
      {
        validate: jest.fn(async () => [
          state({ branch: "me/a", parent: "main" }),
          state({ branch: "me/b", parent: "me/a", containsParent: false }),
        ]),
      },
      { forgeDeps: forge }
    )
    await waitFor(() => expect(screen.getByTestId("stack-publish-stack:me/b")).toBeInTheDocument())
    expect(screen.getByTestId("stack-publish-stack:me/b")).toBeDisabled()
    expect(screen.getByTestId("stack-land-stack:me/b")).toBeDisabled()
  })

  it("reaches nothing until a forge action is pressed", async () => {
    const { injected: forge } = forgeDeps()
    renderPanel({}, { forgeDeps: forge })
    await waitFor(() => expect(screen.getByTestId("stack-stack:me/b")).toBeInTheDocument())
    expect(forge.open).not.toHaveBeenCalled()
  })

  it("says which of the four things is missing instead of doing nothing", async () => {
    const { injected: forge } = forgeDeps({
      open: jest.fn(async (): Promise<StackForge> => ({ status: "noRemote" })),
    })
    renderPanel({}, { forgeDeps: forge })
    await waitFor(() => expect(screen.getByTestId("stack-publish-stack:me/b")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("stack-publish-stack:me/b"))
    await waitFor(() => expect(forge.open).toHaveBeenCalled())
    expect(forge.push).not.toHaveBeenCalled()
    expect(screen.queryByTestId("stack-pr-me/a")).not.toBeInTheDocument()
  })

  it("lands the stack bottom first", async () => {
    const { injected: forge, adapter } = forgeDeps()
    renderPanel({}, { forgeDeps: forge })
    await waitFor(() => expect(screen.getByTestId("stack-publish-stack:me/b")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("stack-publish-stack:me/b"))
    await waitFor(() => expect(screen.getByTestId("stack-pr-me/a")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("stack-land-stack:me/b"))
    await waitFor(() => expect(adapter.merged).toHaveLength(2))
    expect(adapter.merged.map((entry) => entry.pullRequest)).toEqual([1, 2])
  })

  it("pushes a restack only once the stack has pull requests", async () => {
    const injected = renderPanel({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a", containsParent: false }),
      ]),
    })
    await waitFor(() => expect(screen.getByTestId("stack-restack-stack:me/b")).toBeInTheDocument())
    expect(screen.getByTestId("stack-restack-stack:me/b")).toHaveTextContent("Restack")
    await userEvent.click(screen.getByTestId("stack-restack-stack:me/b"))
    await waitFor(() => expect(injected.restack).toHaveBeenCalledWith(STACK, {}))
  })

  it("offers an undo for a layer a restack moved, naming the pinned tip", async () => {
    const injected = renderPanel({
      history: jest.fn(async (_root: string, branch: string) =>
        branch === "me/b"
          ? ([["refs/cognia/stack-history/me/b/1700", "a".repeat(40)]] as Array<[string, string]>)
          : []
      ),
    })
    await waitFor(() => expect(screen.getByTestId("stack-undo-me/b")).toBeInTheDocument())
    // Only the branch that actually moved.
    expect(screen.queryByTestId("stack-undo-me/a")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("stack-undo-me/b"))
    await waitFor(() =>
      expect(injected.revert).toHaveBeenCalledWith(
        "/repos/app",
        "me/b",
        "refs/cognia/stack-history/me/b/1700"
      )
    )
  })

  it("names a new layer's branch from the commit identity, and lets it be overridden", async () => {
    const createBranch = jest.fn(async () => {})
    const injected = renderPanel({ discover: jest.fn(async () => []) }, { createBranch })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())

    await userEvent.click(screen.getByRole("combobox", { name: "On top of" }))
    await userEvent.click(await screen.findByRole("option", { name: "me/a" }))
    await userEvent.type(
      screen.getByRole("textbox", { name: "What the layer does" }),
      "Retry helper"
    )

    const branchField = screen.getByRole("textbox", { name: "Branch name" })
    await waitFor(() => expect(branchField).toHaveValue("ada-lovelace/retry-helper"))

    await userEvent.click(screen.getByTestId("stack-add-layer"))
    // Branch first, pointer second: a pointer to a branch that does not exist
    // is the `missingBranch` problem the validator reports.
    await waitFor(() =>
      expect(createBranch).toHaveBeenCalledWith(
        "/repos/app",
        "ada-lovelace/retry-helper",
        true,
        "me/a"
      )
    )
    expect(injected.setParent).toHaveBeenCalledWith(
      "/repos/app",
      "ada-lovelace/retry-helper",
      "me/a"
    )
  })

  it("says out loud that the other authoring model is not available", async () => {
    // Both are in the type; only one can be produced. An unlabelled half is
    // indistinguishable from one somebody assumes is switched on.
    renderPanel({ discover: jest.fn(async () => []) })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())
    expect(
      screen.getByText(/Authoring a stack as one branch of commits is not available yet/)
    ).toBeInTheDocument()
  })

  it("explains itself when the repository has no stacks", async () => {
    renderPanel({ discover: jest.fn(async () => []) })
    await waitFor(() => expect(screen.getByTestId("stack-panel-empty")).toBeInTheDocument())
    expect(screen.getByTestId("stack-panel-empty")).toHaveTextContent("No stacks recorded")
  })
})

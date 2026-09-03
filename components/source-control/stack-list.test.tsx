/** @jest-environment jsdom */

/**
 * The list's own behaviour lives here. `stack-panel.test.tsx` exercises the
 * same component through the Sheet and keeps the wiring covered end to end,
 * so this file asserts only what is true of the list ITSELF: that it is inert
 * until it is the surface on screen, and that a host can size it.
 *
 * That distinction is the reason for the split. A navigator section and a
 * Sheet both mount this, and a mounted-but-hidden list that still fetched
 * would run the stack validation twice on every panel render.
 */

import { render, screen, waitFor } from "@testing-library/react"

import type { Stack } from "@/lib/stack/model"
import type { RestackStackResult } from "@/lib/stack/restack"
import type { GitBranch, GitStackLayerState } from "@/types/git"

import { StackList } from "./stack-list"

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

function makeBranch(name: string, over: Partial<GitBranch> = {}): GitBranch {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
    ...over,
  }
}

const BRANCHES = [makeBranch("main"), makeBranch("me/a", { isCurrent: true }), makeBranch("me/b")]

function state(over: Partial<GitStackLayerState> & { branch: string }): GitStackLayerState {
  return { parent: null, head: "0".repeat(40), containsParent: true, checkedOutIn: null, ...over }
}

function deps() {
  return {
    discover: jest.fn(async () => [STACK]),
    validate: jest.fn(async () => [
      state({ branch: "me/a", parent: "main" }),
      state({ branch: "me/b", parent: "me/a" }),
    ]),
    restack: jest.fn(async (): Promise<RestackStackResult> => ({
      status: "upToDate",
      verdict: { ok: true, problems: [], remedy: "none" },
    })),
    setParent: jest.fn(async () => {}),
    history: jest.fn(async () => [] as Array<[string, string]>),
    revert: jest.fn(async () => "0".repeat(40)),
  }
}

function renderList(active: boolean, className?: string) {
  const injected = deps()
  const { container } = render(
    <StackList
      active={active}
      rootDir="/repos/app"
      branches={BRANCHES}
      deps={injected as never}
      identity={async () => ({ name: "Ada Lovelace", email: "ada@example.com" })}
      {...(className ? { className } : {})}
    />
  )
  return { injected, container }
}

describe("StackList", () => {
  it("renders the chain when it is the surface on screen", async () => {
    renderList(true)
    await waitFor(() => expect(screen.getByTestId("stack-stack:me/b")).toBeInTheDocument())
    const layers = screen.getByTestId("stack-stack:me/b").querySelectorAll("li")
    expect(layers[0]).toHaveTextContent("me/a")
    expect(layers[1]).toHaveTextContent("me/b")
  })

  /**
   * Both hosts mount this. A hidden one that still read would run discovery
   * and validation, which shell out to git, on every render of the panel
   * beside it.
   */
  it("reads nothing while it is not the surface on screen", async () => {
    const { injected } = renderList(false)
    await waitFor(() => expect(screen.queryByTestId("stack-stack:me/b")).not.toBeInTheDocument())
    expect(injected.discover).not.toHaveBeenCalled()
    expect(injected.validate).not.toHaveBeenCalled()
  })

  it("lets a host size its scroll container", () => {
    const { container } = renderList(true, "h-[20rem]")
    expect(container.querySelector(".h-\\[20rem\\]")).not.toBeNull()
  })
})

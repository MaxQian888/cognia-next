/** @jest-environment jsdom */

jest.mock("@/components/workspace/new-worktree-form", () => ({
  NewWorktreeForm: () => <div data-testid="new-worktree-form-stub" />,
}))
jest.mock("@/components/workspace/workspace-environment-list", () => ({
  WorkspaceEnvironmentList: () => <div data-testid="worktree-list-stub" />,
}))
jest.mock("./stack-list", () => ({
  StackList: ({ active }: { active: boolean }) => (
    <div data-testid="stack-list-stub" data-active={active ? "true" : "false"} />
  ),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { useGitStore } from "@/stores/git/git-store"
import type { GitBranch } from "@/types/git"

import { RepositoryNavigator } from "./repository-navigator"

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

const BRANCHES = [makeBranch("main", { isCurrent: true }), makeBranch("feature")]

function actions() {
  return {
    checkout: jest.fn().mockResolvedValue(undefined),
    createBranch: jest.fn().mockResolvedValue(undefined),
    deleteBranch: jest.fn().mockResolvedValue(undefined),
    renameBranch: jest.fn().mockResolvedValue(undefined),
    rebase: jest.fn().mockResolvedValue(undefined),
    merge: jest.fn().mockResolvedValue(undefined),
  }
}

function renderNavigator() {
  return render(<RepositoryNavigator rootDir="/repo" branches={BRANCHES} actions={actions()} />)
}

beforeEach(() => {
  act(() => {
    useGitStore.getState().reset()
    useGitStore.setState({ rootDir: "/repo", stackParents: [] })
  })
})

describe("RepositoryNavigator", () => {
  it("offers all three of the things a repository is made of", () => {
    renderNavigator()
    expect(screen.getByTestId("navigator-section-branches")).toBeInTheDocument()
    expect(screen.getByTestId("navigator-section-worktrees")).toBeInTheDocument()
    expect(screen.getByTestId("navigator-section-stacks")).toBeInTheDocument()
  })

  it("opens on branches, which is the one a person came for", () => {
    renderNavigator()
    expect(screen.getByTestId("navigator-section-branches")).toHaveAttribute("data-open", "true")
    expect(screen.getByTestId("branch-picker")).toBeInTheDocument()
    expect(screen.queryByTestId("worktree-list-stub")).not.toBeInTheDocument()
  })

  /**
   * The branch list is the same component the header chip opens in a popover.
   * Its `w-72` is that popover's width, and inside a resizable column it would
   * pin the column open at 288px.
   */
  it("lets the branch list fill the column instead of the popover width", () => {
    renderNavigator()
    expect(screen.getByTestId("branch-picker").className).toContain("w-full")
  })

  it("shows one section at a time so the column stays readable", () => {
    renderNavigator()
    fireEvent.click(screen.getByTestId("navigator-toggle-worktrees"))

    expect(screen.getByTestId("navigator-section-worktrees")).toHaveAttribute("data-open", "true")
    expect(screen.getByTestId("navigator-section-branches")).toHaveAttribute("data-open", "false")
    expect(screen.getByTestId("worktree-list-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("branch-picker")).not.toBeInTheDocument()
  })

  it("offers worktree creation beside the inventory, not in a separate sheet", () => {
    renderNavigator()
    fireEvent.click(screen.getByTestId("navigator-toggle-worktrees"))
    expect(screen.getByTestId("new-worktree-form-stub")).toBeInTheDocument()
  })

  /**
   * This column lives for the whole life of the panel. A stack list that read
   * while collapsed would shell out to git for discovery and validation on
   * every render of the diff beside it.
   */
  it("leaves the stack list inert until its section is opened", () => {
    renderNavigator()
    expect(screen.queryByTestId("stack-list-stub")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("navigator-toggle-stacks"))
    expect(screen.getByTestId("stack-list-stub")).toHaveAttribute("data-active", "true")
  })

  it("counts the branches on the section header", () => {
    renderNavigator()
    expect(screen.getByTestId("navigator-section-branches")).toHaveTextContent("2")
  })
})

/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { WorktreesPanel } from "./worktrees-panel"

/**
 * Both halves of this tab moved: the live inventory was a third mount of
 * `WorkspaceEnvironmentList`, and the reclaimed branches are now
 * `components/workspace/agent-branches-section` on the workspace page. What is
 * pinned here is that the tab does not become a blank panel for anyone still
 * holding the retired URL.
 */
describe("WorktreesPanel", () => {
  it("says where the worktrees went instead of rendering nothing", () => {
    render(<WorktreesPanel />)
    expect(screen.getByTestId("worktrees-panel")).toBeInTheDocument()
    expect(screen.getByTestId("worktrees-panel-moved-link")).toHaveAttribute("href", "/workspace")
  })

  it("no longer mounts a second copy of the environment inventory", () => {
    render(<WorktreesPanel />)
    expect(screen.queryByTestId("workspace-environments")).not.toBeInTheDocument()
    expect(screen.queryByTestId("worktrees-list")).not.toBeInTheDocument()
  })
})

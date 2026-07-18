import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectGitReviewPanel } from "./project-git-review-panel"

const gitStage = jest.fn()
const gitUnstage = jest.fn()
const gitDiscard = jest.fn()

jest.mock("@/components/source-control/diff-pane", () => ({
  DiffPane: (props: {
    rootDir: string
    path: string
    actions: {
      stage: (paths: string[]) => void
      unstage: (paths: string[]) => void
      discard: (paths: string[]) => void
    }
  }) => (
    <div data-testid="diff-pane">
      {`${props.rootDir}:${props.path}`}
      <button onClick={() => props.actions.stage([props.path])}>stage</button>
      <button onClick={() => props.actions.unstage([props.path])}>unstage</button>
      <button onClick={() => props.actions.discard([props.path])}>discard</button>
    </div>
  ),
}))
jest.mock("@/lib/git/commands", () => ({
  gitStage: (...args: unknown[]) => gitStage(...args),
  gitUnstage: (...args: unknown[]) => gitUnstage(...args),
  gitDiscard: (...args: unknown[]) => gitDiscard(...args),
}))

describe("ProjectGitReviewPanel", () => {
  it("binds the diff to this workbench's repository and file", () => {
    render(<ProjectGitReviewPanel rootPath="/repo-a" relPath="src/a.ts" />)
    expect(screen.getByTestId("diff-pane")).toHaveTextContent("/repo-a:src/a.ts")
  })

  it("keeps stage, unstage, and discard scoped to this repository", async () => {
    const user = userEvent.setup()
    render(<ProjectGitReviewPanel rootPath="/repo-a" relPath="src/a.ts" />)
    await user.click(screen.getByRole("button", { name: "stage" }))
    await user.click(screen.getByRole("button", { name: "unstage" }))
    await user.click(screen.getByRole("button", { name: "discard" }))
    expect(gitStage).toHaveBeenCalledWith("/repo-a", ["src/a.ts"], undefined)
    expect(gitUnstage).toHaveBeenCalledWith("/repo-a", ["src/a.ts"], undefined)
    expect(gitDiscard).toHaveBeenCalledWith("/repo-a", ["src/a.ts"], undefined)
  })
})

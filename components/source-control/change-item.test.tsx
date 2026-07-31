import { fireEvent, render, screen } from "@testing-library/react"
import { ChangeItem } from "./change-item"
import type { GitFileChange } from "@/types/git"

const change: GitFileChange = {
  path: "src/app/page.tsx",
  origPath: null,
  status: "modified",
  staged: false,
  group: "changes",
}

describe("ChangeItem", () => {
  it("renders the file name, dir, and status letter", () => {
    render(<ChangeItem change={change} selected={false} onSelect={() => {}} />)
    expect(screen.getByText("page.tsx")).toBeInTheDocument()
    expect(screen.getByText("src/app")).toBeInTheDocument()
    expect(screen.getByText("M")).toBeInTheDocument()
  })

  it("renders origName → newName for renamed files", () => {
    const renamed: GitFileChange = {
      path: "src/app/new-name.tsx",
      origPath: "src/app/old-name.tsx",
      status: "renamed",
      staged: true,
      group: "staged",
    }
    render(<ChangeItem change={renamed} selected={false} onSelect={() => {}} />)
    expect(screen.getByTestId(`orig-${renamed.path}`)).toHaveTextContent("old-name.tsx →")
    expect(screen.getByText("new-name.tsx")).toBeInTheDocument()
    expect(screen.getByTitle("src/app/old-name.tsx → src/app/new-name.tsx")).toBeInTheDocument()
  })

  it("selects on click", () => {
    const onSelect = jest.fn()
    render(<ChangeItem change={change} selected={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId(`change-item-${change.path}`))
    expect(onSelect).toHaveBeenCalled()
  })

  it("selects from the keyboard", () => {
    const onSelect = jest.fn()
    render(<ChangeItem change={change} selected={false} onSelect={onSelect} />)

    const item = screen.getByTestId(`change-item-${change.path}`)
    fireEvent.keyDown(item, { key: "Enter" })
    fireEvent.keyDown(item, { key: " " })

    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it("stage button fires onStage without selecting", () => {
    const onSelect = jest.fn()
    const onStage = jest.fn()
    render(<ChangeItem change={change} selected={false} onSelect={onSelect} onStage={onStage} />)
    fireEvent.click(screen.getByTestId(`stage-${change.path}`))
    expect(onStage).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("keeps touch actions visible with 44px hit targets", () => {
    render(
      <ChangeItem
        change={change}
        selected={false}
        onSelect={jest.fn()}
        onStage={jest.fn()}
        density="touch"
      />
    )

    expect(screen.getByTestId(`change-item-${change.path}`)).toHaveClass("min-h-11")
    expect(screen.getByTestId(`stage-${change.path}`)).toHaveClass("size-11")
    expect(screen.getByTestId(`stage-${change.path}`).parentElement).toHaveClass("opacity-100")
  })

  it("shows unstage + discard handlers when provided", () => {
    const onUnstage = jest.fn()
    const onDiscard = jest.fn()
    render(
      <ChangeItem
        change={{ ...change, staged: true }}
        selected
        onSelect={() => {}}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
      />
    )
    fireEvent.click(screen.getByTestId(`unstage-${change.path}`))
    expect(onUnstage).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId(`discard-${change.path}`))
    expect(onDiscard).toHaveBeenCalled()
  })

  it("offers Restore from the context menu when provided", async () => {
    const onRestore = jest.fn()
    render(
      <ChangeItem change={change} selected={false} onSelect={() => {}} onRestore={onRestore} />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${change.path}`))
    fireEvent.click(await screen.findByTestId(`restore-${change.path}`))
    expect(onRestore).toHaveBeenCalled()
  })

  it("keeps the context menu mounted when restore is selected (preventDefault)", async () => {
    const onRestore = jest.fn()
    render(
      <ChangeItem change={change} selected={false} onSelect={() => {}} onRestore={onRestore} />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${change.path}`))
    fireEvent.click(await screen.findByTestId(`restore-${change.path}`))
    expect(onRestore).toHaveBeenCalled()
    // preventDefault keeps the menu open so the dialog never races focus restore.
    expect(screen.getByTestId(`restore-${change.path}`)).toBeInTheDocument()
  })

  it("offers Add to .gitignore only for untracked files", async () => {
    const onAddToGitignore = jest.fn()
    const untracked: GitFileChange = { ...change, status: "untracked" }
    render(
      <ChangeItem
        change={untracked}
        selected={false}
        onSelect={() => {}}
        onAddToGitignore={onAddToGitignore}
      />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${untracked.path}`))
    fireEvent.click(await screen.findByTestId(`gitignore-${untracked.path}`))
    expect(onAddToGitignore).toHaveBeenCalled()
  })

  it("hides Add to .gitignore for tracked files", async () => {
    render(
      <ChangeItem
        change={change}
        selected={false}
        onSelect={() => {}}
        onAddToGitignore={jest.fn()}
        onViewBlame={() => {}}
      />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${change.path}`))
    await screen.findByTestId(`blame-${change.path}`) // menu is open
    expect(screen.queryByTestId(`gitignore-${change.path}`)).not.toBeInTheDocument()
  })

  it("offers View Blame from the context menu when provided", async () => {
    const onViewBlame = jest.fn()
    render(
      <ChangeItem change={change} selected={false} onSelect={() => {}} onViewBlame={onViewBlame} />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${change.path}`))
    fireEvent.click(await screen.findByTestId(`blame-${change.path}`))
    expect(onViewBlame).toHaveBeenCalled()
  })

  it("offers View History from the context menu when provided", async () => {
    const onViewHistory = jest.fn()
    render(
      <ChangeItem
        change={change}
        selected={false}
        onSelect={() => {}}
        onViewHistory={onViewHistory}
      />
    )
    fireEvent.contextMenu(screen.getByTestId(`change-item-${change.path}`))
    fireEvent.click(await screen.findByText("View File History"))
    expect(onViewHistory).toHaveBeenCalled()
  })
})

import { fireEvent, render, screen } from "@testing-library/react"
import { ChangeItem } from "./change-item"
import type { GitFileChange } from "@/lib/git/types"

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

  it("selects on click", () => {
    const onSelect = jest.fn()
    render(<ChangeItem change={change} selected={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId(`change-item-${change.path}`))
    expect(onSelect).toHaveBeenCalled()
  })

  it("stage button fires onStage without selecting", () => {
    const onSelect = jest.fn()
    const onStage = jest.fn()
    render(<ChangeItem change={change} selected={false} onSelect={onSelect} onStage={onStage} />)
    fireEvent.click(screen.getByTestId(`stage-${change.path}`))
    expect(onStage).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
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
})

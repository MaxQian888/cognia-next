import { fireEvent, render, screen } from "@testing-library/react"
import { ChangeGroup } from "./change-group"

describe("ChangeGroup", () => {
  it("renders the count and children when expanded", () => {
    render(
      <ChangeGroup group="staged" count={3} expanded onToggle={() => {}}>
        <div>child</div>
      </ChangeGroup>
    )
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("child")).toBeInTheDocument()
  })

  it("hides children when collapsed", () => {
    render(
      <ChangeGroup group="staged" count={1} expanded={false} onToggle={() => {}}>
        <div>child</div>
      </ChangeGroup>
    )
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("toggles on header click", () => {
    const onToggle = jest.fn()
    render(
      <ChangeGroup group="changes" count={0} expanded onToggle={onToggle}>
        <div />
      </ChangeGroup>
    )
    fireEvent.click(screen.getByTestId("group-toggle-changes"))
    expect(onToggle).toHaveBeenCalled()
  })

  it("renders group actions", () => {
    const onClick = jest.fn()
    render(
      <ChangeGroup
        group="changes"
        count={2}
        expanded
        onToggle={() => {}}
        actions={[{ key: "stage-all", label: "Stage All", icon: <span>+</span>, onClick }]}
      >
        <div />
      </ChangeGroup>
    )
    fireEvent.click(screen.getByTestId("group-action-changes-stage-all"))
    expect(onClick).toHaveBeenCalled()
  })

  it("keeps group actions visible and touch-sized in touch density", () => {
    render(
      <ChangeGroup
        group="changes"
        count={1}
        expanded
        density="touch"
        onToggle={jest.fn()}
        actions={[
          { key: "stage-all", label: "Stage All", icon: <span>+</span>, onClick: jest.fn() },
        ]}
      >
        <div />
      </ChangeGroup>
    )

    const action = screen.getByTestId("group-action-changes-stage-all")
    expect(action).toHaveClass("size-11")
    expect(action.parentElement).toHaveClass("opacity-100")
    expect(screen.getByTestId("group-toggle-changes")).toHaveClass("min-h-11")
  })
})

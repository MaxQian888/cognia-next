import { act, fireEvent, render, screen } from "@testing-library/react"

import type { ProjectEnvironment } from "@/types/project-environment"

import { ProjectEnvironmentList } from "./project-environment-list"

function env(overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Node",
    isEnabled: true,
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function renderList(props: Partial<React.ComponentProps<typeof ProjectEnvironmentList>> = {}) {
  const onSelect = jest.fn()
  const onCreate = jest.fn()
  const onRetry = jest.fn()
  render(
    <ProjectEnvironmentList
      environments={[env()]}
      status="ready"
      selectedId={null}
      onSelect={onSelect}
      onCreate={onCreate}
      onRetry={onRetry}
      {...props}
    />
  )
  return { onSelect, onCreate, onRetry }
}

describe("ProjectEnvironmentList", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("marks the selected row and reports a pick", () => {
    const { onSelect } = renderList({
      environments: [env(), env({ id: "env-2", name: "Python" })],
      selectedId: "env-1",
    })
    expect(screen.getByTestId("project-environment-row-env-1")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("project-environment-row-env-2")).not.toHaveAttribute("aria-current")
    fireEvent.click(screen.getByTestId("project-environment-row-env-2"))
    expect(onSelect).toHaveBeenCalledWith("env-2")
  })

  /** What a Select trigger used to hide until each environment was opened. */
  it("says which is the default, which is off, and how setup last went", () => {
    renderList({
      environments: [
        env({
          lastInitialization: {
            status: "succeeded",
            scope: "local",
            executionRoot: "/repo",
            startedAt: 1,
            completedAt: 2,
          },
        }),
        env({ id: "env-2", name: "Python", isEnabled: false }),
      ],
      defaultEnvironmentId: "env-1",
    })
    const node = screen.getByTestId("project-environment-row-env-1")
    expect(node).toHaveTextContent("Default")
    expect(node).toHaveTextContent("Last setup: succeeded")
    const python = screen.getByTestId("project-environment-row-env-2")
    expect(python).toHaveTextContent("Disabled")
    expect(python).toHaveTextContent("Setup has not run in this workspace yet.")
  })

  it("lists an unsaved definition first and marks it", () => {
    renderList({ unsaved: { id: "draft", name: "" }, selectedId: "draft" })
    const rows = screen.getAllByRole("button").filter((button) => button.dataset.testid)
    expect(rows[0]).toHaveAttribute("data-testid", "project-environment-row-draft")
    expect(rows[0]).toHaveTextContent("Untitled environment")
    expect(rows[0]).toHaveTextContent("Unsaved")
  })

  it("offers creating one from an empty list, with the reason to", () => {
    const { onCreate } = renderList({ environments: [] })
    expect(screen.getByTestId("project-environment-list-empty")).toHaveTextContent(
      "No environments yet"
    )
    fireEvent.click(screen.getByRole("button", { name: /New environment/ }))
    expect(onCreate).toHaveBeenCalled()
  })

  it("states a failed load and offers to read again", () => {
    const { onRetry } = renderList({ status: "error", error: "blocked", environments: [] })
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load environments: blocked")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("shows placeholders only for a wait worth noticing, and no empty claim meanwhile", () => {
    jest.useFakeTimers()
    renderList({ status: "loading", environments: [] })
    expect(screen.queryByTestId("project-environment-list-loading")).not.toBeInTheDocument()
    expect(screen.queryByTestId("project-environment-list-empty")).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(250)
    })
    expect(screen.getByTestId("project-environment-list-loading")).toHaveTextContent(
      "Loading environments…"
    )
    expect(screen.getByRole("button", { name: /New environment/ })).toBeDisabled()
  })

  it("holds every row while a write is in flight", () => {
    renderList({ disabled: true })
    expect(screen.getByTestId("project-environment-row-env-1")).toBeDisabled()
    expect(screen.getByRole("button", { name: /New environment/ })).toBeDisabled()
  })
})

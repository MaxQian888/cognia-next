/** @jest-environment jsdom */
import { selectOption } from "@/lib/testing/select-option"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HarnessTaskCheck } from "@/types/harness/evolution"

const mockList = jest.fn()
jest.mock("@/lib/router-fusion/verify/acceptance-profiles", () => ({
  listAcceptanceProfiles: (id: string) => mockList(id),
}))

import { HarnessTaskChecksEditor, availableCheckKinds } from "./harness-task-checks-editor"

function Harness(props: {
  initial: HarnessTaskCheck[]
  isolation: "none" | "files" | "git"
  projectId?: string
  onChange?: (c: HarnessTaskCheck[]) => void
}) {
  const React = jest.requireActual("react") as typeof import("react")
  const [checks, setChecks] = React.useState(props.initial)
  return (
    <HarnessTaskChecksEditor
      checks={checks}
      onChange={(next) => {
        setChecks(next)
        props.onChange?.(next)
      }}
      isolation={props.isolation}
      {...(props.projectId ? { projectId: props.projectId } : {})}
    />
  )
}

describe("availableCheckKinds", () => {
  it("offers only checks a task of that shape can run", () => {
    expect(availableCheckKinds("none", undefined)).not.toContain("deliverable-file")
    expect(availableCheckKinds("files", undefined)).toContain("deliverable-file")
    expect(availableCheckKinds("files", "p")).not.toContain("acceptance-profile")
    expect(availableCheckKinds("git", undefined)).not.toContain("acceptance-profile")
    expect(availableCheckKinds("git", "p")).toContain("acceptance-profile")
  })
})

describe("HarnessTaskChecksEditor", () => {
  it("adds, edits and removes checks", async () => {
    const onChange = jest.fn()
    render(<Harness initial={[]} isolation="files" onChange={onChange} />)
    expect(screen.getByText(/No checks/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-add-check"))
    expect(onChange).toHaveBeenLastCalledWith([{ kind: "output-contains", value: "" }])
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Total" } })
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "output-contains", value: "Total", caseSensitive: true },
    ])
    await selectOption(screen.getByLabelText("Kind of check"), "output-json")
    fireEvent.click(screen.getByTestId("harness-add-check"))
    fireEvent.change(screen.getByLabelText("Required keys"), { target: { value: "total, rows ," } })
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "output-contains", value: "Total", caseSensitive: true },
      { kind: "output-json", requiredKeys: ["total", "rows"] },
    ])
    await selectOption(screen.getByLabelText("Kind of check"), "max-tool-errors")
    fireEvent.click(screen.getByTestId("harness-add-check"))
    fireEvent.change(screen.getByLabelText("Maximum tool errors"), { target: { value: "2.6" } })
    expect(onChange.mock.lastCall?.[0][2]).toEqual({ kind: "max-tool-errors", max: 3 })
    await selectOption(screen.getByLabelText("Kind of check"), "deliverable-file")
    fireEvent.click(screen.getByTestId("harness-add-check"))
    fireEvent.change(screen.getByLabelText("File path"), { target: { value: "report.md" } })
    expect(onChange.mock.lastCall?.[0][3]).toEqual({ kind: "deliverable-file", path: "report.md" })
    fireEvent.click(screen.getAllByRole("button", { name: "Remove check" })[0])
    expect(onChange.mock.lastCall?.[0]).toHaveLength(3)
  })

  it("offers the workspace's approved acceptance profiles", async () => {
    mockList.mockResolvedValue({
      kind: "declared",
      projectId: "p",
      approvalKey: "/repo",
      overriddenProfiles: [],
      profiles: [
        { id: "unit", status: "approved" },
        { id: "e2e", status: "changed" },
      ],
    })
    const onChange = jest.fn()
    render(
      <Harness
        initial={[{ kind: "acceptance-profile", profileId: "" }]}
        isolation="git"
        projectId="p"
        onChange={onChange}
      />
    )
    await waitFor(() => expect(screen.getByLabelText("Acceptance profile")).toBeInTheDocument())
    expect(screen.queryByRole("option", { hidden: true, name: "e2e" })).not.toBeInTheDocument()
    await selectOption(screen.getByLabelText("Acceptance profile"), "unit")
    expect(onChange).toHaveBeenLastCalledWith([{ kind: "acceptance-profile", profileId: "unit" }])
  })

  it("says when the workspace has no approved profile", async () => {
    mockList.mockResolvedValue({ kind: "absent", projectId: "p" })
    render(
      <Harness
        initial={[{ kind: "acceptance-profile", profileId: "" }]}
        isolation="git"
        projectId="p"
      />
    )
    await waitFor(() => expect(mockList).toHaveBeenCalledWith("p"))
    expect(screen.getByText(/no approved acceptance profiles/)).toBeInTheDocument()
  })
})

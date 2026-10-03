/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { WorkingSetEntry } from "@cognia/agent-config-types"
import { SessionOpenItems, selectOpenItems } from "./session-open-items"

jest.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}))

const entry = (over: Partial<WorkingSetEntry>): WorkingSetEntry =>
  ({
    id: "x",
    kind: "subtask",
    summary: "Something",
    status: "active",
    origin: "agent",
    refs: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as WorkingSetEntry

it("counts only active questions and subtasks as outstanding work", () => {
  const entries = [
    entry({ id: "a", kind: "open-question" }),
    entry({ id: "b", kind: "subtask" }),
    entry({ id: "c", kind: "subtask", status: "resolved" }),
    entry({ id: "d", kind: "decision" }),
    entry({ id: "e", kind: "fact" }),
    entry({ id: "f", kind: "resource" }),
  ]
  expect(selectOpenItems(entries).map((item) => item.id)).toEqual(["a", "b"])
  expect(selectOpenItems(undefined)).toEqual([])
})

it("lists every open item in the overview", () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `i${i}`, summary: `Item ${i}` }))
  render(<SessionOpenItems entries={entries} onNavigate={jest.fn()} />)
  expect(screen.getAllByRole("listitem")).toHaveLength(entries.length)
})

it("marks questions and subtasks apart, and routes to the run context", () => {
  const navigate = jest.fn()
  render(
    <SessionOpenItems
      entries={[
        entry({ id: "q", kind: "open-question", summary: "Which width?" }),
        entry({ id: "s", kind: "subtask", summary: "Pin the test" }),
      ]}
      onNavigate={navigate}
    />
  )
  const [question, subtask] = screen.getAllByRole("listitem")
  expect(question.querySelector("svg")?.getAttribute("class")).toContain("text-warning")
  expect(subtask.querySelector("svg")?.getAttribute("class")).toContain("text-info")
  expect(screen.getByText("2")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "openContext" }))
  expect(navigate).toHaveBeenCalledWith("run-context")
})

it("keeps the route reachable from an empty session and hides the count badge", () => {
  const navigate = jest.fn()
  render(<SessionOpenItems entries={[]} onNavigate={navigate} />)
  expect(screen.getByText("noOpenItems")).toBeVisible()
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument()
  expect(screen.queryByText("0")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "openContext" }))
  expect(navigate).toHaveBeenCalledWith("run-context")
})

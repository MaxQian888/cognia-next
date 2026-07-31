/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { TodoList } from "./todo-list"
import type { TodoEntry } from "@/lib/chat/todos"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const TODOS: TodoEntry[] = [
  { content: "Read the file", status: "completed" },
  { content: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
  { content: "Run the tests", status: "pending" },
]

describe("TodoList", () => {
  it("renders the plan title with done/total counts", () => {
    render(<TodoList todos={TODOS} />)
    expect(screen.getByText('todoPlanTitle:{"done":1,"total":3}')).toBeInTheDocument()
  })

  it("renders each todo's content", () => {
    render(<TodoList todos={TODOS} />)
    expect(screen.getByText("Read the file")).toBeInTheDocument()
    expect(screen.getByText("Run the tests")).toBeInTheDocument()
  })

  it("shows activeForm instead of content for an in-progress todo", () => {
    render(<TodoList todos={TODOS} />)
    expect(screen.getByText("Editing the file")).toBeInTheDocument()
    expect(screen.queryByText("Edit the file")).not.toBeInTheDocument()
  })

  it("falls back to content when an in-progress todo has no activeForm", () => {
    render(<TodoList todos={[{ content: "Build it", status: "in_progress" }]} />)
    expect(screen.getByText("Build it")).toBeInTheDocument()
  })
})

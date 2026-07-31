import { countCompletedTodos, parseTodoInput, type TodoEntry } from "./todos"

describe("parseTodoInput", () => {
  it("parses a valid todo snapshot", () => {
    expect(
      parseTodoInput({
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress", activeForm: "Doing b" },
          { content: "c", status: "completed" },
        ],
      })
    ).toEqual([
      { content: "a", status: "pending", activeForm: undefined },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
      { content: "c", status: "completed", activeForm: undefined },
    ])
  })

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 7],
    ["missing todos", {}],
    ["non-array todos", { todos: "x" }],
    ["empty todos", { todos: [] }],
    ["a non-object item", { todos: [1] }],
    ["a missing content", { todos: [{ status: "pending" }] }],
    ["a non-string content", { todos: [{ content: 1, status: "pending" }] }],
    ["an invalid status", { todos: [{ content: "a", status: "blocked" }] }],
  ])("returns null for %s", (_label, input) => {
    expect(parseTodoInput(input)).toBeNull()
  })

  it("drops a non-string activeForm to undefined", () => {
    const parsed = parseTodoInput({ todos: [{ content: "a", status: "pending", activeForm: 3 }] })
    expect(parsed).toEqual([{ content: "a", status: "pending", activeForm: undefined }])
  })
})

describe("countCompletedTodos", () => {
  it("counts only completed entries", () => {
    const todos: TodoEntry[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d", status: "pending" },
    ]
    expect(countCompletedTodos(todos)).toBe(2)
  })

  it("returns 0 for an empty list", () => {
    expect(countCompletedTodos([])).toBe(0)
  })
})

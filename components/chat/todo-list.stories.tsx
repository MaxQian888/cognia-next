import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { TodoList } from "./todo-list"
import type { TodoEntry } from "@/lib/chat/todos"

const todos: readonly TodoEntry[] = [
  { content: "Read the existing implementation", status: "completed" },
  {
    content: "Refactor the renderer",
    activeForm: "Refactoring the renderer",
    status: "in_progress",
  },
  { content: "Add co-located tests", status: "pending" },
  { content: "Run the full test suite and fix coverage", status: "pending" },
]

const meta = {
  title: "Chat/TodoList",
  component: TodoList,
  args: { todos },
} satisfies Meta<typeof TodoList>

export default meta
type Story = StoryObj<typeof meta>

export const Mixed: Story = {}

export const CollapsedByDefault: Story = { args: { defaultOpen: false } }

export const Empty: Story = { args: { todos: [] } }

export const LongContent: Story = {
  args: {
    todos: [
      {
        content:
          "Investigate why the static export bundles the server-only vector store SDK and trace every transitive import path that reaches it from the chat composer module graph",
        status: "in_progress",
        activeForm:
          "Tracing the transitive import path from the chat composer to the server-only vector store SDK so the mobile bundle stops breaking",
      },
      { content: "Done item with a strike-through treatment", status: "completed" },
    ],
  },
}

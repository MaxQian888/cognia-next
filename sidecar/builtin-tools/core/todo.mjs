// Core `TodoWrite` tool for the ai-sdk path.
//
// The name is EXACTLY "TodoWrite" on purpose: the renderer derives UI part
// types as `tool-${name}` (lib/claude/adapter.ts) and special-cases
// `tool-TodoWrite` with the task-list card (components/chat/
// message-renderer.tsx parseTodoInput). Matching the Anthropic SDK's native
// tool name means the SAME card renders both paths with zero renderer work.
// The input schema mirrors parseTodoInput's expectations verbatim.
//
// Todo state is rendered client-side from the tool_use block; the handler
// just acknowledges so the model sees a stable, cheap result.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolText } from "../safety.mjs"

export const TODO_WRITE_NAME = "TodoWrite"

export const todoWriteShape = {
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("Imperative description of the task."),
        status: z.enum(["pending", "in_progress", "completed"]).describe("Task state."),
        activeForm: z
          .string()
          .optional()
          .describe('Present-continuous label shown while in_progress (e.g. "Running tests").'),
      })
    )
    .min(1)
    .describe("The FULL task list (replaces the previous list entirely)."),
}

export function createTodoWriteTool() {
  async function execTodoWrite(args) {
    const total = args.todos.length
    const done = args.todos.filter((t) => t.status === "completed").length
    const active = args.todos.find((t) => t.status === "in_progress")
    const suffix = active ? ` Currently: ${active.activeForm ?? active.content}.` : ""
    return toolText(`Todo list updated: ${done}/${total} completed.${suffix}`)
  }

  return tool(
    TODO_WRITE_NAME,
    "Update the session task list shown to the user. Pass the complete list every time (it replaces the previous one). Use it to plan multi-step work and mark progress.",
    todoWriteShape,
    execTodoWrite,
    { alwaysLoad: true }
  )
}

import { test } from "node:test"
import assert from "node:assert/strict"

import { createCoreTools, CORE_TOOL_NAMES, CORE_MUTATING_TOOL_NAMES } from "./core-tools.mjs"
import { createReadTracker } from "./read-tracker.mjs"
import { todoWriteShape, TODO_WRITE_NAME, createTodoWriteTool } from "./todo.mjs"
import { SESSION_TASK_TOOL_NAMES, createSessionTaskStore } from "./tasks.mjs"
import { z } from "zod"

test("createCoreTools emits tools in the fixed CORE_TOOL_NAMES order", () => {
  const tools = createCoreTools({ cwd: ".", readTracker: createReadTracker() })
  assert.deepEqual(
    tools.map((t) => t.name),
    [...CORE_TOOL_NAMES]
  )
})

test("every core tool def is well-shaped (name/description/inputSchema/handler)", () => {
  const tools = createCoreTools({ cwd: ".", readTracker: createReadTracker() })
  for (const t of tools) {
    assert.equal(typeof t.name, "string")
    assert.equal(typeof t.description, "string")
    assert.ok(t.description.length > 20, `${t.name} needs a useful description`)
    assert.equal(typeof t.handler, "function")
    assert.ok(t.inputSchema && typeof t.inputSchema === "object")
  }
})

test("mutating subset is exactly edit/multi_edit/write/bash/NotebookEdit/apply_patch", () => {
  assert.deepEqual(
    [...CORE_MUTATING_TOOL_NAMES],
    ["edit", "multi_edit", "write", "bash", "NotebookEdit", "apply_patch"]
  )
  for (const n of CORE_MUTATING_TOOL_NAMES) assert.ok(CORE_TOOL_NAMES.includes(n))
})

test("new session task tools are appended after apply_patch (prompt-cache stability)", () => {
  const patchIndex = CORE_TOOL_NAMES.indexOf("apply_patch")
  assert.ok(patchIndex >= 0)
  assert.deepEqual(CORE_TOOL_NAMES.slice(patchIndex + 1), [
    ...SESSION_TASK_TOOL_NAMES,
    "list_shells",
  ])
})

test("createCoreTools binds structured task tools to the supplied session store", async () => {
  const taskStore = createSessionTaskStore()
  const tools = Object.fromEntries(
    createCoreTools({ cwd: ".", readTracker: createReadTracker(), taskStore }).map((tool) => [
      tool.name,
      tool,
    ])
  )
  await tools.TaskCreate.handler({ subject: "One", description: "First task" }, {})
  const listed = await tools.TaskList.handler({}, {})
  const payload = JSON.parse(listed.content[0].text)
  assert.deepEqual(
    payload.tasks.map((task) => task.subject),
    ["One"]
  )
})

test("TodoWrite name matches the renderer contract exactly", () => {
  assert.equal(TODO_WRITE_NAME, "TodoWrite")
  assert.ok(CORE_TOOL_NAMES.includes("TodoWrite"))
})

test("TodoWrite schema accepts the renderer's parseTodoInput shape", () => {
  const schema = z.object(todoWriteShape)
  const ok = schema.safeParse({
    todos: [
      { content: "Do thing", status: "in_progress", activeForm: "Doing thing" },
      { content: "Next", status: "pending" },
    ],
  })
  assert.equal(ok.success, true)
  const bad = schema.safeParse({ todos: [{ content: "x", status: "cancelled" }] })
  assert.equal(bad.success, false)
})

test("TodoWrite handler summarizes progress", async () => {
  const tool = createTodoWriteTool()
  const res = await tool.handler(
    {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress", activeForm: "Working on b" },
        { content: "c", status: "pending" },
      ],
    },
    {}
  )
  const text = res.content.map((b) => b.text).join("\n")
  assert.match(text, /1\/3 completed/)
  assert.match(text, /Working on b/)
})

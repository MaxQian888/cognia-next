import { test } from "node:test"
import assert from "node:assert/strict"

import { z } from "zod"

import { createSessionTaskStore } from "../../src/tools/state/tasks.ts"
import { createSessionTaskTools, taskCreateShape, taskUpdateShape } from "./tasks.mjs"

function parseText(result) {
  return JSON.parse(result.content.map((block) => block.text ?? "").join("\n"))
}

test("task schemas match the structured Claude Code task contract", () => {
  assert.equal(
    z.object(taskCreateShape).safeParse({
      subject: "Map the tool surface",
      description: "Inventory every built-in tool and its execution path.",
      activeForm: "Mapping the tool surface",
      metadata: { phase: "research" },
    }).success,
    true
  )
  assert.equal(
    z.object(taskUpdateShape).safeParse({
      taskId: "1",
      status: "in_progress",
      addBlockedBy: ["2"],
      removeBlockedBy: ["3"],
      owner: "researcher",
    }).success,
    true
  )
  assert.equal(
    z.object(taskUpdateShape).safeParse({ taskId: "1", status: "unknown" }).success,
    false
  )
})

test("TaskCreate, TaskGet, TaskList, and TaskUpdate share one session store", async () => {
  const store = createSessionTaskStore()
  const tools = Object.fromEntries(createSessionTaskTools(store).map((tool) => [tool.name, tool]))

  const created = parseText(
    await tools.TaskCreate.handler({ subject: "Research", description: "Study current agents" }, {})
  )
  assert.deepEqual(created.task, { id: "1", subject: "Research" })

  const updated = parseText(
    await tools.TaskUpdate.handler({ taskId: "1", status: "in_progress" }, {})
  )
  assert.equal(updated.task.status, "in_progress")

  const fetched = parseText(await tools.TaskGet.handler({ taskId: "1" }, {}))
  assert.equal(fetched.task.description, "Study current agents")

  const listed = parseText(await tools.TaskList.handler({}, {}))
  assert.deepEqual(
    listed.tasks.map((task) => task.id),
    ["1"]
  )
})

test("task tools return structured errors for unknown task ids", async () => {
  const tools = Object.fromEntries(
    createSessionTaskTools(createSessionTaskStore()).map((tool) => [tool.name, tool])
  )
  const result = await tools.TaskGet.handler({ taskId: "missing" }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /task missing not found/)
})

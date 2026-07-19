import { test } from "node:test"
import assert from "node:assert/strict"

import { z } from "zod"

import {
  createSessionTaskStore,
  createSessionTaskTools,
  taskCreateShape,
  taskUpdateShape,
} from "./tasks.mjs"

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

test("session task store creates, reads, and lists stable task ids", () => {
  let now = 100
  const store = createSessionTaskStore({ now: () => now++ })
  const first = store.create({ subject: "First", description: "One" })
  const second = store.create({ subject: "Second", description: "Two" })

  assert.equal(first.id, "1")
  assert.equal(second.id, "2")
  assert.equal(store.get("1")?.subject, "First")
  assert.deepEqual(
    store.list().map((task) => task.id),
    ["1", "2"]
  )
  assert.equal(first.createdAt, 100)
  assert.equal(first.updatedAt, 100)
})

test("dependency updates are reciprocal and block premature completion", () => {
  const store = createSessionTaskStore()
  const prerequisite = store.create({ subject: "Research", description: "Find the gaps" })
  const implementation = store.create({ subject: "Implement", description: "Fill the gaps" })

  const linked = store.update({ taskId: implementation.id, addBlockedBy: [prerequisite.id] })
  assert.deepEqual(linked.blockedBy, [prerequisite.id])
  assert.deepEqual(store.get(prerequisite.id)?.blocks, [implementation.id])

  assert.throws(
    () => store.update({ taskId: implementation.id, status: "completed" }),
    /still blocked by task 1/
  )
  store.update({ taskId: prerequisite.id, status: "completed" })
  assert.equal(store.update({ taskId: implementation.id, status: "completed" }).status, "completed")
})

test("dependency validation rejects missing tasks, self-links, and cycles", () => {
  const store = createSessionTaskStore()
  const a = store.create({ subject: "A", description: "A" })
  const b = store.create({ subject: "B", description: "B" })

  assert.throws(() => store.update({ taskId: a.id, addBlockedBy: ["404"] }), /task 404 not found/)
  assert.throws(
    () => store.update({ taskId: a.id, addBlockedBy: [a.id] }),
    /cannot depend on itself/
  )
  store.update({ taskId: b.id, addBlockedBy: [a.id] })
  assert.throws(() => store.update({ taskId: a.id, addBlockedBy: [b.id] }), /dependency cycle/)
})

test("one TaskUpdate cannot introduce a cycle through multiple new edges", () => {
  const store = createSessionTaskStore()
  const a = store.create({ subject: "A", description: "A" })
  const b = store.create({ subject: "B", description: "B" })
  assert.throws(
    () => store.update({ taskId: a.id, addBlocks: [b.id], addBlockedBy: [b.id] }),
    /dependency cycle/
  )
  assert.deepEqual(store.get(a.id)?.blocks, [])
  assert.deepEqual(store.get(a.id)?.blockedBy, [])
})

test("updates patch task details and deleting a task removes dependency edges", () => {
  const store = createSessionTaskStore()
  const a = store.create({ subject: "A", description: "A", metadata: { phase: "old" } })
  const b = store.create({ subject: "B", description: "B" })
  store.update({ taskId: b.id, addBlockedBy: [a.id] })

  const updated = store.update({
    taskId: a.id,
    subject: "A2",
    activeForm: "Working A2",
    owner: "worker-1",
    metadata: { phase: "new", priority: 1 },
  })
  assert.equal(updated.subject, "A2")
  assert.equal(updated.owner, "worker-1")
  assert.deepEqual(updated.metadata, { phase: "new", priority: 1 })

  const deleted = store.update({ taskId: a.id, status: "deleted" })
  assert.equal(deleted.deleted, true)
  assert.equal(store.get(a.id), undefined)
  assert.deepEqual(store.get(b.id)?.blockedBy, [])
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

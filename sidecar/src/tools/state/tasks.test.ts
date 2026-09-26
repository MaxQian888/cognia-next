import { test } from "node:test"
import assert from "node:assert/strict"

import { createSessionTaskStore } from "./tasks.ts"
import type { DeletedTask, SessionTask } from "./tasks.ts"

/** Narrow an update result to a live task. */
function expectTask(result: SessionTask | DeletedTask): SessionTask {
  assert.ok(!("deleted" in result), "expected a task, got a deletion")
  return result
}

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

  const linked = expectTask(
    store.update({ taskId: implementation.id, addBlockedBy: [prerequisite.id] })
  )
  assert.deepEqual(linked.blockedBy, [prerequisite.id])
  assert.deepEqual(store.get(prerequisite.id)?.blocks, [implementation.id])

  assert.throws(
    () => store.update({ taskId: implementation.id, status: "completed" }),
    /still blocked by task 1/
  )
  store.update({ taskId: prerequisite.id, status: "completed" })
  assert.equal(
    expectTask(store.update({ taskId: implementation.id, status: "completed" })).status,
    "completed"
  )
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

  const updated = expectTask(
    store.update({
      taskId: a.id,
      subject: "A2",
      activeForm: "Working A2",
      owner: "worker-1",
      metadata: { phase: "new", priority: 1 },
    })
  )
  assert.equal(updated.subject, "A2")
  assert.equal(updated.owner, "worker-1")
  assert.deepEqual(updated.metadata, { phase: "new", priority: 1 })

  const deleted = store.update({ taskId: a.id, status: "deleted" })
  assert.deepEqual(deleted, { id: a.id, deleted: true })
  assert.equal(store.get(a.id), undefined)
  assert.deepEqual(store.get(b.id)?.blockedBy, [])
})

test("clearing activeForm and owner with null removes them; other edges can be dropped", () => {
  const store = createSessionTaskStore()
  const a = store.create({ subject: "A", description: "A", activeForm: "Doing A" })
  const b = store.create({ subject: "B", description: "B" })
  store.update({ taskId: a.id, owner: "worker-1", addBlocks: [b.id] })
  const cleared = expectTask(
    store.update({ taskId: a.id, activeForm: null, owner: null, removeBlocks: [b.id] })
  )
  assert.equal("activeForm" in cleared, false)
  assert.equal("owner" in cleared, false)
  assert.deepEqual(cleared.blocks, [])
  assert.deepEqual(store.get(b.id)?.blockedBy, [])
})

test("returned tasks are copies; mutating one does not change the store", () => {
  const store = createSessionTaskStore()
  const a = store.create({ subject: "A", description: "A", metadata: { k: 1 } })
  a.blocks.push("x")
  a.metadata!.k = 2
  assert.deepEqual(store.get(a.id)?.blocks, [])
  assert.deepEqual(store.get(a.id)?.metadata, { k: 1 })
  assert.throws(() => store.update({ taskId: "404" }), /task 404 not found/)
})

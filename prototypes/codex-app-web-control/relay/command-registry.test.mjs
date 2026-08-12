import assert from "node:assert/strict"
import test from "node:test"

import { createCommandRegistry } from "./command-registry.mjs"

test("command registry publishes lifecycle and serializes mutations", async () => {
  const events = []
  const order = []
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const registry = createCommandRegistry(
    [
      {
        id: "task.send",
        title: "Send",
        description: "Send a message",
        scope: "task",
        async execute(input) {
          order.push(`start:${input.value}`)
          if (input.value === 1) await gate
          order.push(`end:${input.value}`)
          return input
        },
      },
    ],
    { publish: (type, payload) => events.push({ type, payload }) }
  )

  const first = registry.execute({ command: "task.send", input: { value: 1 }, requestId: "one" })
  const second = registry.execute({ command: "task.send", input: { value: 2 }, requestId: "two" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ["start:1"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"])
  assert.deepEqual(
    events.map((event) => event.type),
    ["command/started", "command/completed", "command/started", "command/completed"]
  )
})

test("command registry exposes metadata and rejects unknown commands", async () => {
  const registry = createCommandRegistry([
    {
      id: "runtime.status",
      title: "Status",
      description: "Read status",
      scope: "runtime",
      mutates: false,
      inputSchema: { type: "object" },
      execute: async () => ({ ready: true }),
    },
  ])

  assert.equal(registry.list()[0].id, "runtime.status")
  assert.equal("execute" in registry.list()[0], false)
  await assert.rejects(registry.execute({ command: "task.missing" }), /unknown command/)
})

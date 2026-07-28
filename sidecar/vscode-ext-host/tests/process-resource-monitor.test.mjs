import assert from "node:assert/strict"
import { test } from "node:test"

const { monitorProcessResources } = await import("../dist/process-resource-monitor.js")

test("aggregate RSS above the declared limit trips the supervisor once", async () => {
  let intervalCallback
  let cleared = 0
  const errors = []
  const timer = { unref() {} }
  const dispose = monitorProcessResources(
    {
      pid: 42,
      memoryLimitMb: 64,
      onLimitExceeded: (error) => errors.push(error),
    },
    {
      readRssBytes: async () => 65 * 1024 * 1024,
      setInterval: (callback) => {
        intervalCallback = callback
        return timer
      },
      clearInterval: (handle) => {
        assert.equal(handle, timer)
        cleared += 1
      },
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  intervalCallback()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /IDE_PROTOCOL_MEMORY_LIMIT_EXCEEDED/)
  assert.equal(cleared, 1)
  dispose()
})

test("no memory limit installs no sampler", () => {
  let installed = false
  const dispose = monitorProcessResources(
    { pid: 42, onLimitExceeded: () => assert.fail("must not trip") },
    {
      readRssBytes: async () => 0,
      setInterval: () => {
        installed = true
        return { unref() {} }
      },
      clearInterval: () => undefined,
    }
  )
  assert.equal(installed, false)
  dispose()
})

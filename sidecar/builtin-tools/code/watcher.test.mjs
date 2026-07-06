import test from "node:test"
import assert from "node:assert/strict"

import { startWatcher, resolveDebounceMs } from "./watcher.mjs"

test("resolveDebounceMs defaults to 2000 and clamps to [100, 60000]", () => {
  assert.equal(resolveDebounceMs({}), 2000)
  assert.equal(resolveDebounceMs({ CODEGRAPH_WATCH_DEBOUNCE_MS: "abc" }), 2000)
  assert.equal(resolveDebounceMs({ CODEGRAPH_WATCH_DEBOUNCE_MS: "5" }), 100)
  assert.equal(resolveDebounceMs({ CODEGRAPH_WATCH_DEBOUNCE_MS: "999999" }), 60000)
  assert.equal(resolveDebounceMs({ CODEGRAPH_WATCH_DEBOUNCE_MS: "500" }), 500)
})

test("startWatcher debounces a burst into one onChange and filters via accept", async () => {
  let cb = null
  const fakeFs = {
    watch(_root, _opts, handler) {
      cb = handler
      return { close() {} }
    },
  }
  const batches = []
  const w = startWatcher("/root", {
    fsImpl: fakeFs,
    debounceMs: 20,
    accept: (abs) => abs.endsWith(".ts"),
    onChange: (paths) => batches.push(paths),
  })
  assert.equal(w.supported, true)
  cb("change", "a.ts")
  cb("change", "b.ts")
  cb("change", "ignore.md") // filtered out by accept
  cb("change", "a.ts") // dedup
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(batches.length, 1)
  assert.deepEqual([...batches[0]].map((p) => p.replace(/\\/g, "/")).sort(), [
    "/root/a.ts",
    "/root/b.ts",
  ])
  w.dispose()
})

test("startWatcher returns a no-op when recursive watch is unsupported", () => {
  const fakeFs = {
    watch() {
      throw new Error("recursive watch not supported")
    },
  }
  const w = startWatcher("/root", { fsImpl: fakeFs, onChange: () => {} })
  assert.equal(w.supported, false)
  assert.doesNotThrow(() => w.dispose())
})

test("startWatcher swallows errors thrown by onChange", async () => {
  let cb = null
  const fakeFs = {
    watch(_r, _o, handler) {
      cb = handler
      return { close() {} }
    },
  }
  const w = startWatcher("/root", {
    fsImpl: fakeFs,
    debounceMs: 10,
    onChange: () => {
      throw new Error("boom")
    },
  })
  cb("change", "a.ts")
  await new Promise((r) => setTimeout(r, 25))
  // No throw escapes; watcher still disposes cleanly.
  assert.doesNotThrow(() => w.dispose())
})

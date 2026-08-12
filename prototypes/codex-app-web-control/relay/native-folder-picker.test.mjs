import assert from "node:assert/strict"
import test from "node:test"

import { selectNativeFolder } from "./native-folder-picker.mjs"

test("native folder selection uses Standard Additions without Accessibility automation", async () => {
  let invocation
  const selected = await selectNativeFolder({
    commandRunner(command, args, options) {
      invocation = { command, args, options }
      return { ok: true, stdout: "/Users/example/Documents\n" }
    },
  })

  assert.equal(selected, "/Users/example/Documents")
  assert.equal(invocation.command, "/usr/bin/osascript")
  assert.match(invocation.args[1], /choose folder/)
  assert.doesNotMatch(invocation.args[1], /System Events|UI elements/)
})

test("native folder cancellation does not create an attachment", async () => {
  const selected = await selectNativeFolder({
    commandRunner: () => ({ ok: false, stderr: "User canceled. (-128)" }),
  })
  assert.equal(selected, null)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareMobile } from "./prepare-mobile.mjs"

test("mobile preparation retains browser resources without staging desktop runtimes", async () => {
  const calls = []
  await prepareMobile(async (command, args) => calls.push([command, ...args]))
  assert.deepEqual(calls, [
    [process.execPath, "scripts/build/build-workflow-app-embed.mjs"],
    [process.execPath, "scripts/build/build-browser-builtin-plugins.mjs"],
    [process.execPath, "scripts/build/download-cubism-core.mjs"],
    [process.execPath, "scripts/build/copy-monaco-assets.mjs"],
    [process.execPath, "scripts/build/build-artifact-runtime.mjs"],
    [process.execPath, "scripts/build/copy-ocr-assets.mjs"],
    [process.execPath, "scripts/build/build-builtin-skills.mjs"],
    [process.execPath, "scripts/build/build-support-docs.mjs"],
  ])
})

test("preparation stops on failure before building with missing assets", async () => {
  let calls = 0
  await assert.rejects(
    prepareMobile(async () => {
      if (++calls === 2) throw new Error("plugin bundle failed")
    }),
    /plugin bundle failed/
  )
  assert.equal(calls, 2)
})

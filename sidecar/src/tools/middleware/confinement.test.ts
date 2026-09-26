import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { wrapDefsWithConfinement } from "./confinement.ts"
import { firstText } from "../../../test-support/tool-result.ts"
import type { CallableTool } from "../../../test-support/tool-result.ts"
import type { ToolDefinition } from "../kernel/define.ts"

// A real directory, canonicalised: macOS tmpdir sits behind the /var symlink.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confinement-root-")))
const SCOPE = { launcher: "", writableRoots: [ROOT], readableRoots: [], network: false }

/** A `write` def that records the calls that reach its body. */
function recordingWrite(calls: unknown[][]): ToolDefinition {
  return {
    name: "write",
    handler: async (args: unknown, extra?: unknown) => {
      calls.push([args, extra])
      return { content: [{ type: "text", text: "wrote" }] }
    },
  }
}

test("without a sandbox scope the definitions come back untouched", () => {
  const defs = [recordingWrite([])]
  assert.equal(wrapDefsWithConfinement(defs, undefined, ROOT), defs)
})

test("a call outside the writable roots is refused before the body runs", async () => {
  const calls: unknown[][] = []
  const [write] = wrapDefsWithConfinement([recordingWrite(calls)], SCOPE, ROOT) as CallableTool[]
  const outside = path.join(os.tmpdir(), "elsewhere", "x.txt")
  const result = await write!.handler({ file_path: outside, content: "x" })
  assert.equal(result.isError, true)
  assert.match(firstText(result), /workspace sandbox refused write/)
  assert.deepEqual(calls, [])
})

test("a call inside the writable roots reaches the body with its arguments and context", async () => {
  const calls: unknown[][] = []
  const [write] = wrapDefsWithConfinement([recordingWrite(calls)], SCOPE, ROOT) as CallableTool[]
  const args = { file_path: path.join(ROOT, "x.txt"), content: "x" }
  const extra = { signal: new AbortController().signal }
  const result = await write!.handler(args, extra)
  assert.equal(firstText(result), "wrote")
  assert.deepEqual(calls, [[args, extra]])
})

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

// Wiring test for the Code presentation: the sidecar decides which tool defs
// exist from `execution.composition.toolPresentation`, and the code broker
// dispatches back into exactly the defs this session assembled.
import { test } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

// A real exec wrapper that passes fds through — exercises the launcher path
// without requiring bwrap/sandbox-exec on the test machine.
const LAUNCHER = JSON.stringify(["/usr/bin/env"])

import { applyToolPresentation } from "../index.mjs"

const CALLS = []

function def(name, result = { ok: name }) {
  return {
    name,
    handler: async (input) => {
      CALLS.push({ name, input })
      return result
    },
  }
}

/** A native surface containing one eligible and one ineligible tool. */
function nativeDefs() {
  return [def("read"), def("write"), def("TodoWrite")]
}

function reset() {
  CALLS.length = 0
}

test("native presentation returns the surface untouched", () => {
  const defs = nativeDefs()
  assert.equal(applyToolPresentation(defs, "native"), defs)
})

test("an absent presentation behaves as native", () => {
  const defs = nativeDefs()
  assert.equal(applyToolPresentation(defs, undefined), defs)
})

test("an unrecognised presentation behaves as native rather than failing open", () => {
  const defs = nativeDefs()
  assert.equal(applyToolPresentation(defs, "something-new"), defs)
})

test("code presentation replaces the whole surface with run_code", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const defs = applyToolPresentation(nativeDefs(), "code")
    assert.deepEqual(
      defs.map((d) => d.name),
      ["run_code"]
    )
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("both presentation appends run_code to the native surface", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const defs = applyToolPresentation(nativeDefs(), "both")
    assert.deepEqual(
      defs.map((d) => d.name),
      ["read", "write", "TodoWrite", "run_code"]
    )
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

// The fail-closed shape at the registration layer: no sandbox means code
// presentation exposes NOTHING, rather than quietly reverting to native.
test("code presentation exposes no tools at all on an unsandboxed host", () => {
  delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  assert.deepEqual(applyToolPresentation(nativeDefs(), "code"), [])
})

test("both presentation keeps only the native surface on an unsandboxed host", () => {
  delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  assert.deepEqual(
    applyToolPresentation(nativeDefs(), "both").map((d) => d.name),
    ["read", "write", "TodoWrite"]
  )
})

test("the broker dispatches an eligible call into this session's own def", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(nativeDefs(), "code")
    const result = await runCode.handler({
      source: 'return await cognia.read({ path: "a.ts" })',
    })
    assert.deepEqual(JSON.parse(result.content[0].text).result, { ok: "read" })
    assert.deepEqual(CALLS, [{ name: "read", input: { path: "a.ts" } }])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("a tool whose category is disabled reports that, rather than failing generically", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    // `read` is eligible but absent from this session's surface.
    const [runCode] = applyToolPresentation([def("grep")], "code")
    const result = await runCode.handler({
      source: "try { await cognia.read({}) } catch (e) { return e.message }",
    })
    assert.match(JSON.parse(result.content[0].text).result, /not enabled in this session/)
    assert.deepEqual(CALLS, [])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("an ineligible tool stays unreachable even though it is on the native surface", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(nativeDefs(), "code")
    const result = await runCode.handler({
      source: 'return typeof cognia.write + "," + typeof cognia.TodoWrite',
    })
    assert.equal(JSON.parse(result.content[0].text).result, "undefined,undefined")
    assert.deepEqual(CALLS, [])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("matches namespaced defs by their bare name", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation([def("mcp__cognia-tools__read")], "code")
    const result = await runCode.handler({ source: "return await cognia.read({})" })
    assert.deepEqual(JSON.parse(result.content[0].text).result, {
      ok: "mcp__cognia-tools__read",
    })
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("the SDK declaration advertises only the tools this session enabled", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(
      [
        // A zod raw shape, which is what `collectCogniaToolDefs` actually
        // produces. Handing the renderer a hand-written JSON Schema here is
        // what once hid every signature degrading to `input: unknown`.
        { ...def("read"), inputSchema: { path: z.string() } },
        def("write"),
        def("TodoWrite"),
      ],
      "code"
    )
    // `read` is eligible and present; `write`/`TodoWrite` are not eligible, and
    // `grep` is eligible but absent from this session.
    assert.match(runCode.description, /read\(input: \{/)
    assert.ok(!runCode.description.includes("write("))
    assert.ok(!runCode.description.includes("TodoWrite("))
    assert.ok(!runCode.description.includes("grep("))
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("the SDK declaration renders real field names from the def's zod shape", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(
      [
        {
          ...def("read"),
          inputSchema: { path: z.string(), limit: z.number().optional() },
        },
      ],
      "code"
    )
    // The whole point of the declaration: a signature the model can write
    // against. `input: unknown` means it has to guess the shape instead.
    assert.ok(!runCode.description.includes("read(input: unknown)"))
    assert.match(runCode.description, /path\??: string/)
    assert.match(runCode.description, /limit\?: number/)
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("the broker applies the def's zod defaults before calling the handler", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(
      [
        {
          ...def("read"),
          inputSchema: { path: z.string(), maxResults: z.number().min(1).default(100) },
        },
      ],
      "code"
    )
    await runCode.handler({ source: 'return await cognia.read({ path: "a.ts" })' })
    // Unparsed, `maxResults` would arrive undefined and every `length >=
    // maxResults` cap in the handler would be permanently false.
    assert.deepEqual(CALLS, [{ name: "read", input: { path: "a.ts", maxResults: 100 } }])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("the broker rejects arguments the def's schema does not accept", async () => {
  reset()
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(
      [{ ...def("read"), inputSchema: { path: z.string() } }],
      "code"
    )
    const result = await runCode.handler({
      source: "try { await cognia.read({ path: 42 }) } catch (e) { return e.message }",
    })
    // A validation message the model can act on, rather than a TypeError from
    // deep inside a handler that assumed a string.
    assert.match(JSON.parse(result.content[0].text).result, /invalid arguments for "read"/)
    assert.deepEqual(CALLS, [])
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

test("the declaration carries the real schema, not an invented one", () => {
  process.env.COGNIA_CODE_SANDBOX_LAUNCHER = LAUNCHER
  try {
    const [runCode] = applyToolPresentation(
      [
        {
          ...def("read"),
          // The production shape: a zod raw shape, converted by the broker.
          inputSchema: { path: z.string().describe("Absolute path") },
        },
      ],
      "code"
    )
    assert.match(runCode.description, /path: string/)
    assert.match(runCode.description, /Absolute path/)
  } finally {
    delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  }
})

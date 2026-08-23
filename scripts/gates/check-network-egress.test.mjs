import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
  REASONS,
  blankNonCode,
  blankRustTestModules,
  diffAgainstAllowlist,
  findConstructorCalls,
  findFetchCalls,
  findRustEgress,
  firstTopLevelArgument,
  isScaffolding,
  isTypedParameter,
  keyOf,
  validateAllowlist,
} from "./check-network-egress.mjs"

test("finds a plain fetch call", () => {
  const hits = findFetchCalls("const res = await fetch(url)")
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, "fetch")
})

test("ignores a property access that ends in fetch", () => {
  assert.deepEqual(findFetchCalls("await plugin.fetch(url)"), [])
  assert.deepEqual(findFetchCalls("await proxyFetch(url)"), [])
  assert.deepEqual(findFetchCalls("await cloudFetch({ url })"), [])
})

test("ignores method and interface declarations named fetch", () => {
  // The three shapes a naive regex reads as calls.
  assert.deepEqual(findFetchCalls("async fetch(ref: RemoteDocRef): Promise<Doc> {"), [])
  assert.deepEqual(findFetchCalls("  fetch(remote?: string, prune?: boolean): Promise<void>"), [])
  assert.deepEqual(findFetchCalls("  fetch(ctx) {\n    return run(ctx)\n  },"), [])
})

test("still finds a call whose options object looks like a typed parameter list", () => {
  // `{ signal: x }` has exactly the shape of an annotation; only the FIRST
  // top-level argument may decide, or this regresses to a silent miss.
  const hits = findFetchCalls("await fetch(egress.url, { method, signal: init.signal })")
  assert.equal(hits.length, 1)
})

test("firstTopLevelArgument stops at the first depth-0 comma", () => {
  assert.equal(firstTopLevelArgument("url, { a: 1, b: 2 }"), "url")
  assert.equal(firstTopLevelArgument("{ a: 1, b: 2 }"), "{ a: 1, b: 2 }")
  assert.equal(firstTopLevelArgument("ref: Ref, opts: Opts"), "ref: Ref")
})

test("isTypedParameter recognizes annotations and not object properties", () => {
  assert.equal(isTypedParameter("ref: RemoteDocRef"), true)
  assert.equal(isTypedParameter("remote?: string"), true)
  assert.equal(isTypedParameter("url"), false)
  assert.equal(isTypedParameter("{ signal: x }"), false)
})

test("finds WebSocket and EventSource constructors", () => {
  const hits = findConstructorCalls("const ws = new WebSocket(u)\nconst es = new EventSource(v)")
  assert.deepEqual(hits.map((hit) => hit.kind).sort(), ["eventsource", "websocket"])
})

test("finds unmanaged Rust clients and explicit opt-outs", () => {
  const hits = findRustEgress("let c = reqwest::Client::new();\nlet d = b.no_proxy().build();")
  assert.deepEqual(hits.map((hit) => hit.kind).sort(), ["no-proxy", "reqwest-client-new"])
})

test("blankNonCode hides strings and comments but preserves line numbers", () => {
  const source = [
    "// await fetch(a)",
    "/* await fetch(b) */",
    'const t = "await fetch(c)"',
    "await fetch(d)",
  ].join("\n")
  const code = blankNonCode(source)
  assert.equal(code.split("\n").length, 4)
  assert.equal(findFetchCalls(code).length, 1)
})

test("blankNonCode leaves a template literal's interpolation out of reach", () => {
  // A generated-code template that contains `async fetch(request, env)` must
  // not be read as product code.
  const source = "const tpl = `export default {\n  async fetch(request, env) {}\n}`"
  assert.deepEqual(findFetchCalls(blankNonCode(source)), [])
})

test("blankRustTestModules removes inline test scaffolding", () => {
  const source = [
    "fn real() { let c = reqwest::Client::new(); }",
    "#[cfg(test)]",
    "mod tests {",
    "    fn t() { let c = reqwest::Client::new(); }",
    "}",
  ].join("\n")
  assert.equal(findRustEgress(blankRustTestModules(source)).length, 1)
})

test("isScaffolding excludes tests, stories, mocks and integration dirs", () => {
  assert.equal(isScaffolding("lib/network/proxy-fetch.test.ts"), true)
  assert.equal(isScaffolding("components/a/b.stories.tsx"), true)
  assert.equal(isScaffolding("lib/__mocks__/thing.ts"), true)
  assert.equal(isScaffolding("crates/cognia-gateway/tests/phase2.rs"), true)
  assert.equal(isScaffolding("crates/cognia-gateway/benches/e2e.rs"), true)
  assert.equal(isScaffolding("lib/network/proxy-fetch.ts"), false)
})

test("keyOf is file+kind, not line — an edit above an exception must not fail the build", () => {
  assert.equal(keyOf({ file: "a.ts", line: 10, kind: "fetch" }), "a.ts::fetch")
  assert.equal(keyOf({ file: "a.ts", line: 99, kind: "fetch" }), "a.ts::fetch")
})

test("validateAllowlist requires a known reason and a real note", () => {
  const errors = validateAllowlist({
    exceptions: [{ file: "a.ts", kind: "fetch", reason: "because", note: "short" }],
  })
  assert.ok(errors.some((error) => error.includes("reason")))
  assert.ok(errors.some((error) => error.includes("note")))
})

test("validateAllowlist rejects wildcards and directory prefixes", () => {
  for (const file of ["lib/**", "lib/*.ts", "lib/network/"]) {
    const errors = validateAllowlist({
      exceptions: [
        { file, kind: "fetch", reason: "loopback", note: "a sufficiently long explanation" },
      ],
    })
    assert.ok(
      errors.some((error) => error.includes("wildcards")),
      `expected ${file} to be rejected`
    )
  }
})

test("validateAllowlist rejects duplicates", () => {
  const entry = { file: "a.ts", kind: "fetch", reason: "loopback", note: "a long enough reason" }
  const errors = validateAllowlist({ exceptions: [entry, { ...entry }] })
  assert.ok(errors.some((error) => error.includes("duplicate")))
})

test("validateAllowlist accepts a well-formed entry", () => {
  assert.deepEqual(
    validateAllowlist({
      exceptions: [
        {
          file: "lib/network/proxy-fetch.ts",
          kind: "fetch",
          reason: "transport-impl",
          note: "The browser arm of the transport itself.",
        },
      ],
    }),
    []
  )
})

test("every reason in the vocabulary is documented as a constant", () => {
  assert.ok(REASONS.has("loopback"))
  assert.ok(REASONS.has("transport-impl"))
  assert.ok(!REASONS.has("legacy"))
})

test("diff reports unlisted findings and stale exceptions", () => {
  const allowlist = {
    exceptions: [
      { file: "old.ts", kind: "fetch", reason: "loopback", note: "a long enough reason" },
    ],
  }
  const { unlisted, stale } = diffAgainstAllowlist(
    [{ file: "new.ts", line: 3, kind: "fetch" }],
    allowlist
  )
  assert.deepEqual(
    unlisted.map((finding) => finding.file),
    ["new.ts"]
  )
  // A stale exception silently re-opens the next bare call in that file.
  assert.deepEqual(stale, ["old.ts::fetch"])
})

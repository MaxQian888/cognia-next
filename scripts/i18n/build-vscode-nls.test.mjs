import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { buildNlsContent } from "./build-vscode-nls.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const EXT_DIR = join(ROOT, "sidecar", "codeserver-agent-ext")

const manifest = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8"))
const en = JSON.parse(buildNlsContent("en"))
const zh = JSON.parse(buildNlsContent("zh-CN"))

/** Every `%key%` placeholder the manifest actually asks the workbench to fill. */
function manifestPlaceholders(value, found = new Set()) {
  if (typeof value === "string") {
    const match = /^%(.+)%$/.exec(value)
    if (match) found.add(match[1])
    return found
  }
  if (Array.isArray(value)) {
    for (const entry of value) manifestPlaceholders(entry, found)
    return found
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) manifestPlaceholders(entry, found)
  }
  return found
}

test("every manifest placeholder resolves in both locales", () => {
  const placeholders = [...manifestPlaceholders(manifest.contributes)]
  assert.ok(placeholders.length > 0, "the manifest should use %key% placeholders")
  for (const key of placeholders) {
    assert.ok(en[key], `en is missing ${key}`)
    assert.ok(zh[key], `zh-CN is missing ${key}`)
  }
})

test("the two locales carry identical key sets", () => {
  // A key present in one locale only is exactly the drift this generator exists
  // to prevent — the manifest would fall back to the raw `%key%` for the other.
  assert.deepEqual(Object.keys(en), Object.keys(zh))
})

test("zh-CN is actually translated, not copied", () => {
  assert.notEqual(en["command.chat.explain.title"], zh["command.chat.explain.title"])
  assert.match(zh["command.chat.explain.title"], /[一-鿿]/)
})

test("runtime panel strings ride along in the same source", () => {
  // Pushed over the bridge rather than substituted by the workbench, but kept
  // here so the manifest and runtime vocabularies cannot drift apart.
  assert.ok(en["panel.disconnected"])
  assert.ok(zh["panel.disconnected"])
})

test("output is deterministic and key-sorted", () => {
  const first = buildNlsContent("en")
  assert.equal(first, buildNlsContent("en"))
  const keys = Object.keys(JSON.parse(first))
  assert.deepEqual(keys, [...keys].sort())
})

test("the checked-in artifacts match the source", () => {
  assert.equal(readFileSync(join(EXT_DIR, "package.nls.json"), "utf8"), buildNlsContent("en"))
  assert.equal(
    readFileSync(join(EXT_DIR, "package.nls.zh-cn.json"), "utf8"),
    buildNlsContent("zh-CN")
  )
})

test("a missing locale source fails loudly", () => {
  assert.throws(() => buildNlsContent("de"), /missing/)
})

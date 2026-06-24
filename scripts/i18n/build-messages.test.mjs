import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleLocale, buildLocaleContent, isPlainObject } from "./build-messages.mjs"
import { splitLocale, SUBSPLIT } from "./split-messages.mjs"
import { serialize } from "../sync/sort-i18n.mjs"

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "i18n-build-"))
}

test("assembleLocale: plain namespace file maps to its top-level key", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    mkdirSync(localeDir, { recursive: true })
    writeFileSync(join(localeDir, "chat.json"), JSON.stringify({ send: "Send" }))
    writeFileSync(join(localeDir, "providers.json"), JSON.stringify({ openai: "OpenAI" }))
    assert.deepEqual(assembleLocale(localeDir), {
      chat: { send: "Send" },
      providers: { openai: "OpenAI" },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("assembleLocale: sub-split namespace composes _root leaves + per-key object files", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    const nsDir = join(localeDir, "settings")
    mkdirSync(nsDir, { recursive: true })
    writeFileSync(join(nsDir, "_root.json"), JSON.stringify({ title: "Settings", close: "Close" }))
    writeFileSync(join(nsDir, "appearance.json"), JSON.stringify({ theme: "Theme" }))
    writeFileSync(join(nsDir, "data.json"), JSON.stringify({ backup: "Backup" }))
    assert.deepEqual(assembleLocale(localeDir), {
      settings: {
        title: "Settings",
        close: "Close",
        appearance: { theme: "Theme" },
        data: { backup: "Backup" },
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("assembleLocale: sub-split namespace without _root.json composes object files only", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    const nsDir = join(localeDir, "mobile")
    mkdirSync(nsDir, { recursive: true })
    writeFileSync(join(nsDir, "sync.json"), JSON.stringify({ pull: "Pull" }))
    writeFileSync(join(nsDir, "share.json"), JSON.stringify({ title: "Share" }))
    assert.deepEqual(assembleLocale(localeDir), {
      mobile: { sync: { pull: "Pull" }, share: { title: "Share" } },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("assembleLocale: ignores non-json files", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    mkdirSync(localeDir, { recursive: true })
    writeFileSync(join(localeDir, "chat.json"), JSON.stringify({ send: "Send" }))
    writeFileSync(join(localeDir, "README.md"), "not json")
    assert.deepEqual(assembleLocale(localeDir), { chat: { send: "Send" } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("assembleLocale: throws when a namespace is both a file and a directory", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    mkdirSync(join(localeDir, "settings"), { recursive: true })
    writeFileSync(join(localeDir, "settings", "appearance.json"), JSON.stringify({ theme: "T" }))
    writeFileSync(join(localeDir, "settings.json"), JSON.stringify({ title: "S" }))
    assert.throws(() => assembleLocale(localeDir), /both file and directory/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildLocaleContent: output is sorted canonical form (matches serialize)", () => {
  const dir = makeTmp()
  try {
    const localeDir = join(dir, "en")
    mkdirSync(localeDir, { recursive: true })
    // intentionally unsorted keys
    writeFileSync(join(localeDir, "zeta.json"), JSON.stringify({ b: "B", a: "A" }))
    writeFileSync(join(localeDir, "alpha.json"), JSON.stringify({ z: "Z" }))
    const out = buildLocaleContent("en", dir)
    assert.equal(out, serialize({ zeta: { b: "B", a: "A" }, alpha: { z: "Z" } }))
    assert.ok(out.endsWith("\n"))
    // alpha sorts before zeta at the top level
    assert.ok(out.indexOf('"alpha"') < out.indexOf('"zeta"'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("splitLocale writes split sources that re-assemble to the original (lossless)", () => {
  const dir = makeTmp()
  try {
    const messagesDir = join(dir, "i18n", "messages")
    mkdirSync(messagesDir, { recursive: true })
    const original = {
      chat: { send: "Send", nested: { deep: "x" } },
      providers: { a: "1", b: "2" }, // flat → single file (not sub-split)
      settings: {
        title: "Settings", // stray scalar → _root.json
        close: "Close",
        appearance: { theme: "Theme" },
        data: { backup: "B" },
      },
      mobile: { sync: { pull: "Pull" } }, // sub-split, no _root
      arrays: { list: [1, 2, 3] }, // array leaf preserved verbatim
    }
    writeFileSync(join(messagesDir, "en.json"), serialize(original))

    // splitLocale self-verifies internally; it throws if assemble != original.
    splitLocale("en", messagesDir)

    // And re-assert from the outside through the public assemble path.
    assert.equal(serialize(assembleLocale(join(messagesDir, "en"))), serialize(original))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("splitLocale clears stale split files before writing", () => {
  const dir = makeTmp()
  try {
    const messagesDir = join(dir, "i18n", "messages")
    mkdirSync(join(messagesDir, "en"), { recursive: true })
    // a stale split file that no longer corresponds to any big-file namespace
    writeFileSync(join(messagesDir, "en", "obsolete.json"), JSON.stringify({ gone: "x" }))
    writeFileSync(join(messagesDir, "en.json"), serialize({ chat: { send: "Send" } }))

    splitLocale("en", messagesDir)

    assert.deepEqual(assembleLocale(join(messagesDir, "en")), { chat: { send: "Send" } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("isPlainObject distinguishes objects from arrays/null/primitives", () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject({ a: 1 }), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject("s"), false)
  assert.equal(isPlainObject(3), false)
})

test("SUBSPLIT contains exactly the object-dominant >=30KB namespaces", () => {
  assert.deepEqual([...SUBSPLIT].sort(), ["mobile", "plugins", "settings", "workflows"])
})

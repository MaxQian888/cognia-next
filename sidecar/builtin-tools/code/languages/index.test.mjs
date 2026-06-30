import test from "node:test"
import assert from "node:assert/strict"

import {
  languageFor,
  grammarKeyFor,
  isSupportedFile,
  queriesFor,
  grammarAssets,
  SUPPORTED_LANGUAGES,
  GRAMMAR_KEYS,
  EXT_TO_LANGUAGE,
} from "./index.mjs"

test("languageFor maps extensions to language ids", () => {
  assert.equal(languageFor("a/b/c.ts"), "typescript")
  assert.equal(languageFor("x.tsx"), "typescript")
  assert.equal(languageFor("x.mts"), "typescript")
  assert.equal(languageFor("x.js"), "javascript")
  assert.equal(languageFor("x.mjs"), "javascript")
  assert.equal(languageFor("lib.rs"), "rust")
  assert.equal(languageFor("m.py"), "python")
  assert.equal(languageFor("stub.pyi"), "python")
})

test("languageFor returns null for unsupported / empty", () => {
  assert.equal(languageFor("README.md"), null)
  assert.equal(languageFor("noext"), null)
  assert.equal(languageFor(""), null)
  assert.equal(languageFor(null), null)
})

test("grammarKeyFor splits tsx vs typescript and routes js to tsx", () => {
  assert.equal(grammarKeyFor("a.ts"), "typescript")
  assert.equal(grammarKeyFor("a.tsx"), "tsx")
  assert.equal(grammarKeyFor("a.js"), "tsx")
  assert.equal(grammarKeyFor("a.jsx"), "tsx")
  assert.equal(grammarKeyFor("a.rs"), "rust")
  assert.equal(grammarKeyFor("a.py"), "python")
  assert.equal(grammarKeyFor("a.txt"), null)
  assert.equal(grammarKeyFor(""), null)
})

test("isSupportedFile reflects languageFor", () => {
  assert.equal(isSupportedFile("a.ts"), true)
  assert.equal(isSupportedFile("a.md"), false)
})

test("queriesFor returns a bundle and throws for unknown", () => {
  const ts = queriesFor("typescript")
  assert.ok(ts.SYMBOL_TYPES.function_declaration)
  assert.throws(() => queriesFor("cobol"), /unsupported language/)
})

test("SUPPORTED_LANGUAGES and GRAMMAR_KEYS are the expected sets", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), ["javascript", "python", "rust", "typescript"])
  assert.deepEqual([...GRAMMAR_KEYS].sort(), ["python", "rust", "tsx", "typescript"])
})

test("grammarAssets names a wasm per grammar key", () => {
  const assets = grammarAssets().sort()
  assert.deepEqual(assets, [
    "tree-sitter-python.wasm",
    "tree-sitter-rust.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-typescript.wasm",
  ])
})

test("every mapped extension has both a language and a grammar key", () => {
  for (const ext of Object.keys(EXT_TO_LANGUAGE)) {
    assert.ok(languageFor(`f${ext}`), `language for ${ext}`)
    assert.ok(grammarKeyFor(`f${ext}`), `grammar for ${ext}`)
  }
})

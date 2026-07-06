import { test } from "node:test"
import assert from "node:assert/strict"

import { CLI_LANGUAGES, isSupportedLanguage } from "./languages.mjs"

test("CLI_LANGUAGES lists the 25 supported languages, frozen and unique", () => {
  assert.equal(CLI_LANGUAGES.length, 25)
  assert.ok(Object.isFrozen(CLI_LANGUAGES))
  assert.equal(new Set(CLI_LANGUAGES).size, 25)
  for (const lang of ["typescript", "tsx", "python", "rust", "go"]) {
    assert.ok(CLI_LANGUAGES.includes(lang), `expected ${lang}`)
  }
})

test("isSupportedLanguage accepts known languages and rejects others", () => {
  assert.equal(isSupportedLanguage("typescript"), true)
  assert.equal(isSupportedLanguage("cobol"), false)
  assert.equal(isSupportedLanguage(undefined), false)
  assert.equal(isSupportedLanguage(123), false)
})

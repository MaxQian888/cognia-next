import { test } from "node:test"
import assert from "node:assert/strict"
import { findMalformedMessages, validateBundles, LOCALES } from "./validate-icu.mjs"

test("findMalformedMessages: flags a literal double-brace token", () => {
  const bad = findMalformedMessages({ a: { b: "Hi {{contact.name}}!" } }, "en")
  assert.equal(bad.length, 1)
  assert.equal(bad[0].key, "a.b")
  assert.match(bad[0].message, /MALFORMED_ARGUMENT/)
})

test("findMalformedMessages: flags an unclosed-tag-like placeholder", () => {
  const bad = findMalformedMessages({ help: "use group:<uin> here" }, "en")
  assert.equal(bad.length, 1)
  assert.match(bad[0].message, /UNCLOSED_TAG/)
})

test("findMalformedMessages: flags a bare JSON example", () => {
  const bad = findMalformedMessages({ ph: '{ "HTTP-Referer": "x" }' }, "en")
  assert.equal(bad.length, 1)
  assert.match(bad[0].message, /MALFORMED_ARGUMENT/)
})

test("findMalformedMessages: apostrophe-escaped literals are valid", () => {
  const messages = {
    body: "Hi '{{'contact.name'}}'!",
    desc: "supports '{{'variable'}}' tokens",
    tag: "use group:'<'uin> here",
    json: "'{' \"HTTP-Referer\": \"x\" '}'",
  }
  assert.deepEqual(findMalformedMessages(messages, "en"), [])
})

test("findMalformedMessages: real ICU placeholders and plurals stay valid", () => {
  const messages = {
    del: "Delete {title}",
    count: "{count, plural, one {# item} other {# items}}",
  }
  assert.deepEqual(findMalformedMessages(messages, "en"), [])
})

test("findMalformedMessages: strings without ICU-special chars are skipped", () => {
  // No `{` or `<` — cannot be malformed and next-intl never compiles them.
  assert.deepEqual(findMalformedMessages({ plain: "Just plain text." }, "en"), [])
})

test("validateBundles: the committed en/zh-CN bundles have zero malformed messages", () => {
  const results = validateBundles()
  for (const locale of LOCALES) {
    assert.deepEqual(
      results[locale],
      [],
      `${locale}.json has malformed ICU messages: ${JSON.stringify(results[locale], null, 2)}`
    )
  }
})

import assert from "node:assert/strict"
import test from "node:test"

import { parseChangeset } from "./build-evidence.mjs"

// Run with `node --test web/scripts/` — root Jest ignores `/scripts/*.test.mjs`
// because these use Node's built-in runner and native ESM.

test("parseChangeset reads the bump and the prose body", () => {
  const parsed = parseChangeset(
    "artifact-dock",
    ["---", '"cognia-next": minor', "---", "", "Polish the chat artifact dock.", ""].join("\n")
  )
  assert.deepEqual(parsed, {
    id: "artifact-dock",
    bump: "minor",
    summary: "Polish the chat artifact dock.",
  })
})

test("parseChangeset handles every bump level", () => {
  for (const bump of ["major", "minor", "patch"]) {
    const parsed = parseChangeset("x", `---\n"cognia-next": ${bump}\n---\n\nBody.\n`)
    assert.equal(parsed.bump, bump)
  }
})

test("parseChangeset tolerates CRLF line endings", () => {
  const parsed = parseChangeset("x", '---\r\n"cognia-next": patch\r\n---\r\n\r\nBody.\r\n')
  assert.equal(parsed.bump, "patch")
  assert.equal(parsed.summary, "Body.")
})

test("parseChangeset keeps multi-paragraph bodies intact", () => {
  const parsed = parseChangeset("x", '---\n"cognia-next": minor\n---\n\nFirst.\n\nSecond.\n')
  assert.equal(parsed.summary, "First.\n\nSecond.")
})

test("parseChangeset defaults to patch when the frontmatter declares no bump", () => {
  const parsed = parseChangeset("x", '---\n"cognia-next":\n---\n\nBody.\n')
  assert.equal(parsed.bump, "patch")
})

test("parseChangeset rejects an empty frontmatter block as malformed", () => {
  // Every real changeset names a package; a bare `---\n---` is not one, and
  // guessing a bump for it would put an invented severity on the changelog.
  assert.equal(parseChangeset("x", "---\n---\n\nBody.\n"), null)
})

test("parseChangeset rejects a file with no frontmatter", () => {
  assert.equal(parseChangeset("x", "Just prose, no frontmatter.\n"), null)
})

test("parseChangeset rejects an entry with an empty body", () => {
  // An entry with a bump but nothing to say would render as a blank row.
  assert.equal(parseChangeset("x", '---\n"cognia-next": patch\n---\n\n   \n'), null)
})

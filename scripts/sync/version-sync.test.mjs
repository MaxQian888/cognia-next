/**
 * Coverage for scripts/sync/version-sync.mjs — the pure version helpers.
 *
 * Run with: node --test scripts/sync/version-sync.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  TARGETS,
  isValidVersion,
  extractVersion,
  replaceVersion,
  parseArgs,
} from "./version-sync.mjs"

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("isValidVersion accepts semver and semver with pre/build tails", () => {
  assert.ok(isValidVersion("0.1.0"))
  assert.ok(isValidVersion("12.34.56"))
  assert.ok(isValidVersion("1.2.3-beta.1"))
  assert.ok(isValidVersion("1.2.3+build.9"))
})

test("isValidVersion rejects malformed versions", () => {
  assert.ok(!isValidVersion("1.2"))
  assert.ok(!isValidVersion("v1.2.3"))
  assert.ok(!isValidVersion(""))
  assert.ok(!isValidVersion(undefined))
  assert.ok(!isValidVersion(123))
})

test("extractVersion reads the top-level field from JSON", () => {
  const json = '{\n  "name": "x",\n  "version": "1.4.2",\n  "private": true\n}\n'
  assert.equal(extractVersion(json, "json"), "1.4.2")
})

test("extractVersion reads the [package] version from Cargo.toml", () => {
  const cargo = '[package]\nname = "x"\nversion = "2.0.1"\nedition = "2021"\n'
  assert.equal(extractVersion(cargo, "cargo"), "2.0.1")
})

test("extractVersion returns null when no version literal exists", () => {
  assert.equal(extractVersion('{\n  "name": "x"\n}\n', "json"), null)
  assert.equal(extractVersion('[package]\nname = "x"\n', "cargo"), null)
})

test("replaceVersion rewrites the JSON top-level field only", () => {
  const json = '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": { "dep": "1.0.0" }\n}\n'
  const out = replaceVersion(json, "json", "9.9.9")
  assert.match(out, /"version": "9\.9\.9"/)
  // The dependency's version literal (not a "version": field) is untouched.
  assert.match(out, /"dep": "1\.0\.0"/)
})

test("replaceVersion rewrites only the first (package) version in Cargo.toml", () => {
  const cargo =
    '[package]\nname = "x"\nversion = "1.0.0"\n\n[dependencies]\nserde = "1.0.0"\nother = { version = "3.2.1" }\n'
  const out = replaceVersion(cargo, "cargo", "9.9.9")
  assert.match(out, /^version = "9\.9\.9"$/m)
  // Dependency versions use `name = "…"` / inline tables, never a line-start
  // `version = "…"`, so they are left intact.
  assert.match(out, /serde = "1\.0\.0"/)
  assert.match(out, /other = \{ version = "3\.2\.1" \}/)
})

test("replaceVersion is idempotent", () => {
  const json = '{\n  "version": "5.5.5"\n}\n'
  assert.equal(replaceVersion(json, "json", "5.5.5"), json)
})

test("replaceVersion is a no-op when no version literal is present", () => {
  const content = '{\n  "name": "x"\n}\n'
  assert.equal(replaceVersion(content, "json", "1.0.0"), content)
})

test("TARGETS covers the app-version group and excludes independent packages", () => {
  const paths = TARGETS.map((t) => t.path)
  // App group present.
  assert.ok(paths.includes("src-tauri/tauri.conf.json"))
  assert.ok(paths.includes("src-tauri/Cargo.toml"))
  assert.ok(paths.includes("cli/package.json"))
  assert.ok(paths.includes("sidecar/package.json"))
  assert.ok(paths.includes("mobile/package.json"))
  // Independently-versioned things must NOT be swept in.
  assert.ok(!paths.some((p) => p.startsWith("services/")))
  assert.ok(!paths.some((p) => p.includes("plugin-template")))
  assert.ok(!paths.includes("packages/plugin-sdk/package.json"))
  // Every target declares a known kind.
  for (const t of TARGETS) {
    assert.ok(t.kind === "json" || t.kind === "cargo", `bad kind for ${t.path}`)
  }
})

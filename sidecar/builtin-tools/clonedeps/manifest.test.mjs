import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MAX_DEPENDENCIES,
  emptyManifest,
  parseManifest,
  safeRepoName,
  isHttpsRepoUrl,
  upsertDependency,
  serializeManifest,
} from "./manifest.mjs"

test("emptyManifest has the current version and no dependencies", () => {
  const m = emptyManifest()
  assert.equal(m.version, "1.0.0")
  assert.deepEqual(m.dependencies, [])
})

test("parseManifest degrades malformed / partial input to empty", () => {
  assert.deepEqual(parseManifest("").dependencies, [])
  assert.deepEqual(parseManifest("{not json").dependencies, [])
  assert.deepEqual(parseManifest("[]").dependencies, [])
  assert.deepEqual(parseManifest('{"dependencies":"nope"}').dependencies, [])
})

test("parseManifest keeps only well-formed dependency entries", () => {
  const text = JSON.stringify({
    version: "9.9.9",
    updatedAt: "t",
    dependencies: [{ repoUrl: "https://x/y.git", path: "p" }, { bogus: true }, null],
  })
  const m = parseManifest(text)
  assert.equal(m.version, "9.9.9")
  assert.equal(m.dependencies.length, 1)
  assert.equal(m.dependencies[0].repoUrl, "https://x/y.git")
})

test("safeRepoName derives owner__repo, lowercased, sanitized", () => {
  assert.equal(safeRepoName("https://github.com/opencode-ai/opencode.git"), "opencode-ai__opencode")
  assert.equal(safeRepoName("https://github.com/Owner/Repo"), "owner__repo")
  assert.equal(safeRepoName("https://gitlab.com/group/sub/proj.git/"), "sub__proj")
  assert.throws(() => safeRepoName(""), /non-empty/)
})

test("isHttpsRepoUrl accepts only https URLs", () => {
  assert.equal(isHttpsRepoUrl("https://github.com/a/b.git"), true)
  assert.equal(isHttpsRepoUrl("http://github.com/a/b.git"), false)
  assert.equal(isHttpsRepoUrl("git@github.com:a/b.git"), false)
  assert.equal(isHttpsRepoUrl("/local/path"), false)
  assert.equal(isHttpsRepoUrl(undefined), false)
})

test("upsertDependency appends, drops undefined fields, stamps updatedAt", () => {
  const m = upsertDependency(
    emptyManifest(),
    { repoUrl: "https://x/y.git", path: ".cognia/clonedeps/repos/x__y", reason: "r" },
    "2026-01-01T00:00:00.000Z"
  )
  assert.equal(m.dependencies.length, 1)
  assert.equal(m.updatedAt, "2026-01-01T00:00:00.000Z")
  assert.ok(!("name" in m.dependencies[0])) // undefined stripped
  assert.equal(m.dependencies[0].reason, "r")
})

test("upsertDependency replaces an entry with the same path+packagePath", () => {
  let m = upsertDependency(
    emptyManifest(),
    { repoUrl: "https://x/y.git", path: "p", packagePath: "pkg/a", reason: "one" },
    "t1"
  )
  m = upsertDependency(
    m,
    { repoUrl: "https://x/y.git", path: "p", packagePath: "pkg/a", reason: "two" },
    "t2"
  )
  assert.equal(m.dependencies.length, 1)
  assert.equal(m.dependencies[0].reason, "two")
})

test("upsertDependency lets two packages from one repo coexist", () => {
  let m = upsertDependency(
    emptyManifest(),
    { repoUrl: "https://x/y.git", path: "p", packagePath: "pkg/a" },
    "t1"
  )
  m = upsertDependency(m, { repoUrl: "https://x/y.git", path: "p", packagePath: "pkg/b" }, "t2")
  assert.equal(m.dependencies.length, 2)
})

test("upsertDependency enforces the MAX_DEPENDENCIES cap for new entries only", () => {
  let m = emptyManifest()
  for (let i = 0; i < MAX_DEPENDENCIES; i++) {
    m = upsertDependency(m, { repoUrl: `https://x/y${i}.git`, path: `p${i}` }, "t")
  }
  assert.equal(m.dependencies.length, MAX_DEPENDENCIES)
  assert.throws(
    () => upsertDependency(m, { repoUrl: "https://x/over.git", path: "pover" }, "t"),
    /safety cap/
  )
  // Re-adding an EXISTING entry must not trip the cap.
  const same = upsertDependency(m, { repoUrl: "https://x/y0.git", path: "p0", reason: "upd" }, "t2")
  assert.equal(same.dependencies.length, MAX_DEPENDENCIES)
})

test("serializeManifest emits pretty JSON with a trailing newline", () => {
  const s = serializeManifest(emptyManifest())
  assert.ok(s.endsWith("\n"))
  assert.equal(JSON.parse(s).version, "1.0.0")
})

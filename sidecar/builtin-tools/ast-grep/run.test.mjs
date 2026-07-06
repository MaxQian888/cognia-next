import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { buildArgs, parseSgJson, runSg, DEFAULT_MAX_MATCHES } from "./run.mjs"

// ---- buildArgs ------------------------------------------------------------

test("buildArgs builds a minimal search invocation with default path '.'", () => {
  assert.deepEqual(buildArgs({ pattern: "console.log($M)", lang: "typescript" }), [
    "run",
    "-p",
    "console.log($M)",
    "--lang",
    "typescript",
    "--json=compact",
    ".",
  ])
})

test("buildArgs threads rewrite, update-all, context, globs, and explicit paths", () => {
  const args = buildArgs({
    pattern: "a",
    lang: "rust",
    rewrite: "b",
    updateAll: true,
    context: 2,
    globs: ["src/**", "!**/target/**"],
    paths: ["src", "lib"],
  })
  assert.ok(args.includes("-r") && args.includes("b"))
  assert.ok(args.includes("--update-all"))
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", "2"])
  assert.equal(args.filter((a) => a === "--globs").length, 2)
  assert.ok(args.includes("src") && args.includes("lib"))
})

test("buildArgs omits --update-all when not a rewrite and ignores zero context", () => {
  const args = buildArgs({ pattern: "a", lang: "go", context: 0 })
  assert.ok(!args.includes("--update-all"))
  assert.ok(!args.includes("-C"))
})

// ---- parseSgJson ----------------------------------------------------------

test("parseSgJson returns empty for blank output", () => {
  assert.deepEqual(parseSgJson("  \n "), { matches: [], totalMatches: 0 })
})

test("parseSgJson reports a parse error on malformed JSON", () => {
  const r = parseSgJson("{not json")
  assert.equal(r.totalMatches, 0)
  assert.match(r.error, /Failed to parse ast-grep output/)
})

test("parseSgJson tolerates non-array JSON", () => {
  assert.deepEqual(parseSgJson('{"a":1}'), { matches: [], totalMatches: 0 })
})

test("parseSgJson normalises entries and defaults missing fields", () => {
  const json = JSON.stringify([
    {
      file: "a.ts",
      text: "x",
      range: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } },
    },
    { file: "b.ts", text: "y", replacement: "z" },
  ])
  const r = parseSgJson(json)
  assert.equal(r.totalMatches, 2)
  assert.equal(r.matches[0].range.start.line, 3)
  assert.equal(r.matches[1].range.start.line, 0) // missing range → 0
  assert.equal(r.matches[1].replacement, "z")
})

test("parseSgJson caps at the match limit and flags truncation", () => {
  const arr = Array.from({ length: DEFAULT_MAX_MATCHES + 5 }, (_, i) => ({
    file: "f",
    text: String(i),
  }))
  const r = parseSgJson(JSON.stringify(arr))
  assert.equal(r.matches.length, DEFAULT_MAX_MATCHES)
  assert.equal(r.totalMatches, DEFAULT_MAX_MATCHES + 5)
  assert.equal(r.truncated, true)
  assert.match(r.truncatedReason, /match limit/)
})

// ---- runSg (fake spawn) ---------------------------------------------------

/** Build a fake child that emits the given stdout then closes with `code`. */
function fakeSpawnFactory({ stdout = "", stderr = "", code = 0, emitError, hang = false } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
    }
    if (hang) return child // never emits close → exercises timeout
    setImmediate(() => {
      if (emitError) {
        child.emit("error", new Error(emitError))
        return
      }
      if (stdout) child.stdout.emit("data", stdout)
      if (stderr) child.stderr.emit("data", stderr)
      child.emit("close", code)
    })
    return child
  }
}

test("runSg returns a clean error when no binary resolves", async () => {
  const r = await runSg({ pattern: "a", lang: "go" }, { detectImpl: async () => null })
  assert.equal(r.totalMatches, 0)
  assert.match(r.error, /ast-grep is not available/)
})

test("runSg parses a successful search via injected spawn", async () => {
  const stdout = JSON.stringify([
    {
      file: "a.ts",
      text: "console.log(1)",
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
    },
  ])
  const r = await runSg(
    { pattern: "console.log($M)", lang: "typescript" },
    { sgPath: "/fake/sg", spawnImpl: fakeSpawnFactory({ stdout }) }
  )
  assert.equal(r.totalMatches, 1)
  assert.equal(r.matches[0].file, "a.ts")
})

test("runSg surfaces a CLI error (non-zero exit, empty stdout)", async () => {
  const r = await runSg(
    { pattern: "bad(", lang: "typescript" },
    { sgPath: "/fake/sg", spawnImpl: fakeSpawnFactory({ stderr: "pattern error", code: 1 }) }
  )
  assert.match(r.error, /pattern error/)
})

test("runSg reports spawn 'error' events", async () => {
  const r = await runSg(
    { pattern: "a", lang: "go" },
    { sgPath: "/fake/sg", spawnImpl: fakeSpawnFactory({ emitError: "ENOENT" }) }
  )
  assert.match(r.error, /ENOENT/)
})

test("runSg truncates when output exceeds maxBuffer", async () => {
  const big = JSON.stringify([{ file: "a", text: "x" }]) + " ".repeat(50)
  const r = await runSg(
    { pattern: "a", lang: "go" },
    { sgPath: "/fake/sg", spawnImpl: fakeSpawnFactory({ stdout: big }), maxBuffer: 10 }
  )
  assert.equal(r.truncated, true)
})

test("runSg times out a hung process", async () => {
  const r = await runSg(
    { pattern: "a", lang: "go" },
    { sgPath: "/fake/sg", spawnImpl: fakeSpawnFactory({ hang: true }), timeoutMs: 20 }
  )
  assert.equal(r.truncated, true)
  assert.match(r.error, /timed out/)
})

test("runSg catches a synchronous spawn throw", async () => {
  const r = await runSg(
    { pattern: "a", lang: "go" },
    {
      sgPath: "/fake/sg",
      spawnImpl: () => {
        throw new Error("spawn EACCES")
      },
    }
  )
  assert.match(r.error, /spawn EACCES/)
})

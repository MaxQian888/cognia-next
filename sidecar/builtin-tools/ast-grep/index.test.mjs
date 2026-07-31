import { test } from "node:test"
import assert from "node:assert/strict"

import {
  astGrepTools,
  astGrepSearchTool,
  astGrepReplaceTool,
  AST_GREP_TOOL_NAMES,
  __testExports,
} from "./index.mjs"

const { execAstGrepSearch, execAstGrepReplace } = __testExports

function textOf(result) {
  return result.content[0].text
}

test("category exports the two tools in stable order", () => {
  assert.deepEqual(AST_GREP_TOOL_NAMES, ["ast_grep_search", "ast_grep_replace"])
  assert.deepEqual(
    astGrepTools.map((t) => t.name),
    AST_GREP_TOOL_NAMES
  )
  assert.equal(astGrepSearchTool.name, "ast_grep_search")
  assert.equal(astGrepReplaceTool.name, "ast_grep_replace")
})

test("execAstGrepSearch formats matches via injected runner", async () => {
  const run = async (opts) => {
    assert.equal(opts.pattern, "console.log($M)")
    assert.equal(opts.lang, "typescript")
    return {
      matches: [
        {
          file: "a.ts",
          text: "console.log(1)",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
        },
      ],
      totalMatches: 1,
    }
  }
  const r = await execAstGrepSearch({ pattern: "console.log($M)", lang: "typescript" }, { run })
  assert.ok(!r.isError)
  assert.match(textOf(r), /Found 1 matches in 1 files/)
})

test("execAstGrepSearch appends a hint on an empty result for a malformed pattern", async () => {
  const run = async () => ({ matches: [], totalMatches: 0 })
  const r = await execAstGrepSearch({ pattern: "function $NAME", lang: "typescript" }, { run })
  assert.ok(!r.isError)
  assert.match(textOf(r), /No matches found/)
  assert.match(textOf(r), /need params and body/)
})

test("execAstGrepSearch surfaces runner errors as tool errors", async () => {
  const run = async () => ({ matches: [], totalMatches: 0, error: "ast-grep is not available" })
  const r = await execAstGrepSearch({ pattern: "a", lang: "go" }, { run })
  assert.equal(r.isError, true)
  assert.match(textOf(r), /not available/)
})

test("execAstGrepSearch catches a thrown runner", async () => {
  const run = async () => {
    throw new Error("kaboom")
  }
  const r = await execAstGrepSearch({ pattern: "a", lang: "go" }, { run })
  assert.equal(r.isError, true)
  assert.match(textOf(r), /ast_grep_search: kaboom/)
})

test("execAstGrepReplace defaults to dry-run (no disk write)", async () => {
  let seen
  const run = async (opts) => {
    seen = opts
    return {
      matches: [
        {
          file: "a.ts",
          text: "console.log(x)",
          replacement: "logger.info(x)",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        },
      ],
      totalMatches: 1,
    }
  }
  const r = await execAstGrepReplace(
    { pattern: "console.log($M)", rewrite: "logger.info($M)", lang: "typescript" },
    { run }
  )
  assert.equal(seen.updateAll, false) // dry run → do not write
  assert.match(textOf(r), /\[DRY RUN\]/)
})

test("execAstGrepReplace with dry_run:false writes (updateAll true)", async () => {
  let seen
  const run = async (opts) => {
    seen = opts
    return {
      matches: [
        {
          file: "a.ts",
          text: "a",
          replacement: "b",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        },
      ],
      totalMatches: 1,
    }
  }
  const r = await execAstGrepReplace(
    { pattern: "a", rewrite: "b", lang: "rust", dry_run: false },
    { run }
  )
  assert.equal(seen.updateAll, true)
  assert.match(textOf(r), /\[APPLIED\]/)
})

test("execAstGrepReplace surfaces runner errors and thrown runners", async () => {
  const err = await execAstGrepReplace(
    { pattern: "a", rewrite: "b", lang: "go" },
    { run: async () => ({ matches: [], totalMatches: 0, error: "bad lang" }) }
  )
  assert.equal(err.isError, true)
  assert.match(textOf(err), /bad lang/)

  const thrown = await execAstGrepReplace(
    { pattern: "a", rewrite: "b", lang: "go" },
    {
      run: async () => {
        throw new Error("nope")
      },
    }
  )
  assert.equal(thrown.isError, true)
  assert.match(textOf(thrown), /ast_grep_replace: nope/)
})

test("exec handlers fall back to the real runner when given the SDK tool context", async () => {
  // The SDK passes its context object (no `run`) as the 2nd arg; exec must not
  // crash and must reach the real runSg (which reports the binary unavailable
  // in this hermetic env, or returns a real result if installed).
  const r = await execAstGrepSearch({ pattern: "a", lang: "go" }, { sessionID: "s1" })
  assert.ok(typeof textOf(r) === "string")
})

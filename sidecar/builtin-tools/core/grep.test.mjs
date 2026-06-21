import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createGrepTool, pageLines, groupByFile, DEFAULT_HEAD_LIMIT } from "./grep.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "grep-"))
  await fsp.mkdir(path.join(dir, "src"), { recursive: true })
  await fsp.writeFile(
    path.join(dir, "src", "a.ts"),
    "line one\nneedle here\nline three\nline four\nanother needle\n"
  )
  await fsp.writeFile(path.join(dir, "src", "b.md"), "needle in docs\n")
  await fsp.writeFile(path.join(dir, "src", "c.ts"), "nothing\n")
  return dir
}

test("files_with_matches mode lists matching files only (default)", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "needle" }, {}))
    assert.ok(text.includes("a.ts"))
    assert.ok(text.includes("b.md"))
    assert.ok(!text.includes("c.ts"))
    assert.ok(!text.includes("needle here"), "no content lines in files mode")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("content mode groups multi-match files under one path header (token-saving)", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "needle", output_mode: "content" }, {}))
    // a.ts has two hits ⇒ path hoisted once, then bare `line:text` rows.
    assert.match(text, /^src\/a\.ts$/m)
    assert.match(text, /^2:needle here$/m)
    assert.match(text, /^5:another needle$/m)
    // The path is NOT repeated on every match line.
    assert.ok(!/a\.ts:2:needle here/.test(text), "path should be hoisted, not inline")
    // b.md has a single hit ⇒ kept inline (hoisting would only add a line).
    assert.match(text, /^src\/b\.md:1:needle in docs$/m)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("groupByFile hoists a repeated path but leaves lone matches and non-matches inline", () => {
  const out = groupByFile([
    "src/a.ts:2:needle here",
    "src/a.ts:5:another needle",
    "src/b.md:1:needle in docs",
    "--",
  ])
  assert.deepEqual(out, [
    "src/a.ts",
    "2:needle here",
    "5:another needle",
    "src/b.md:1:needle in docs",
    "--",
  ])
})

test("content mode with context lines includes neighbours", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(
      await tool.handler({ pattern: "needle here", output_mode: "content", context: 1 }, {})
    )
    assert.ok(text.includes("line one"))
    assert.ok(text.includes("line three"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("count mode returns per-file counts", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "needle", output_mode: "count" }, {}))
    assert.match(text, /a\.ts:2/)
    assert.match(text, /b\.md:1/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("glob filter narrows the searched files", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "needle", glob: "**/*.md" }, {}))
    assert.ok(text.includes("b.md"))
    assert.ok(!text.includes("a.ts"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("case_insensitive matches differently-cased text", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "NEEDLE", case_insensitive: true }, {}))
    assert.ok(text.includes("a.ts"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("no matches yields a clean message", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "zzz_absent" }, {}))
    assert.match(text, /No matches found/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("head_limit + offset page through content with a continuation note", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const first = textOf(
      await tool.handler({ pattern: "needle", output_mode: "content", head_limit: 1 }, {})
    )
    assert.match(first, /truncated/)
    assert.match(first, /offset=1/)
    const second = textOf(
      await tool.handler(
        { pattern: "needle", output_mode: "content", head_limit: 1, offset: 1 },
        {}
      )
    )
    assert.ok(!second.includes("needle here") || !first.includes("needle here"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("invalid regex surfaces as a tool error", async () => {
  const dir = await fixture()
  try {
    const tool = createGrepTool({ cwd: dir })
    const res = await tool.handler({ pattern: "([" }, {})
    assert.equal(res.isError, true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("pageLines applies offset then head_limit", () => {
  const lines = ["a", "b", "c", "d"]
  assert.deepEqual(pageLines(lines, { offset: 1, headLimit: 2 }), {
    lines: ["b", "c"],
    truncated: true,
  })
  assert.deepEqual(pageLines(lines, { offset: 0, headLimit: 0 }), {
    lines,
    truncated: false,
  })
  assert.equal(DEFAULT_HEAD_LIMIT, 250)
})

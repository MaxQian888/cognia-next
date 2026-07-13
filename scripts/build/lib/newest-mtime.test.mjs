import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { newestMtimeMs } from "./newest-mtime.mjs"

test("returns 0 for a missing directory", () => {
  assert.equal(newestMtimeMs(join(tmpdir(), "definitely-missing-dir-xyz")), 0)
})

test("returns the newest mtime across nested files, filtered by extension", () => {
  const root = mkdtempSync(join(tmpdir(), "newest-mtime-"))
  mkdirSync(join(root, "nested"), { recursive: true })
  writeFileSync(join(root, "a.ts"), "a")
  writeFileSync(join(root, "nested", "b.ts"), "b")
  writeFileSync(join(root, "nested", "c.md"), "c")
  const old = new Date("2020-01-01")
  const mid = new Date("2023-01-01")
  const newest = new Date("2025-01-01")
  utimesSync(join(root, "a.ts"), old, old)
  utimesSync(join(root, "nested", "b.ts"), mid, mid)
  utimesSync(join(root, "nested", "c.md"), newest, newest)
  // .md is filtered out, so the newest *considered* file is b.ts
  assert.equal(newestMtimeMs(root, { exts: [".ts"] }), mid.getTime())
  // unfiltered scan sees c.md
  assert.equal(newestMtimeMs(root), newest.getTime())
})

test("node_modules and dist are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "newest-mtime-skip-"))
  mkdirSync(join(root, "node_modules"), { recursive: true })
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "src.ts"), "s")
  writeFileSync(join(root, "node_modules", "x.ts"), "x")
  writeFileSync(join(root, "dist", "y.ts"), "y")
  const old = new Date("2020-01-01")
  utimesSync(join(root, "src.ts"), old, old)
  assert.equal(newestMtimeMs(root, { exts: [".ts"] }), old.getTime())
})

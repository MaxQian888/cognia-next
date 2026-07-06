import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import { createIndexService } from "./index-service.mjs"

async function tmpRepo(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-svc-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
  }
  return root
}

test("ensureIndexed builds the graph; status/search/context/callers work", async () => {
  const root = await tmpRepo({
    "src/fmt.ts": `export function format(s: string): string { return s.trim(); }\n`,
    "src/app.ts": `import { format } from "./fmt";\nexport function run(x: string) { return format(x); }\n`,
    "README.md": "# ignored\n",
  })
  const svc = createIndexService({ root, forceMemory: true })
  try {
    await svc.ensureIndexed()
    const st = svc.status()
    assert.equal(st.indexed, true)
    assert.equal(st.fileCount, 2) // only .ts files, not README.md
    assert.ok(st.nodeCount >= 2)
    assert.equal(st.languages.typescript, 2)

    // search finds format
    const hits = svc.search("format")
    const fmt = hits.find((h) => h.name === "format")
    assert.ok(fmt)

    // cross-file call resolved: run() calls format()
    const callers = svc.callers(fmt.id)
    assert.ok(callers.some((c) => c.node?.name === "run"))

    // verbatim snippet
    const node = svc.getNode(fmt.id)
    assert.match(svc.snippetFor(node), /return s\.trim/)

    // context composite
    const ctx = svc.context("how does run format input")
    assert.ok(ctx.entryPoints.length >= 1)
    assert.ok(ctx.relatedFiles.length >= 1)

    // files listing
    assert.equal(svc.files().length, 2)
  } finally {
    svc.dispose()
  }
})

test("syncStale picks up a content change and re-resolves", async () => {
  const root = await tmpRepo({
    "a.ts": `export function alpha() { return 1; }\n`,
  })
  const svc = createIndexService({ root, forceMemory: true, now: makeClock() })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.search("beta").length, 0)
    await fsp.writeFile(path.join(root, "a.ts"), `export function beta() { return 2; }\n`)
    // advance throttle window by re-creating clock effect: now() jumps below.
    const changed = await svc.syncStale()
    assert.ok(changed >= 1)
    assert.ok(svc.search("beta").length >= 1)
    assert.equal(svc.search("alpha").length, 0) // old symbol gone
  } finally {
    svc.dispose()
  }
})

test("a deleted file is dropped from the index", async () => {
  const root = await tmpRepo({
    "keep.ts": `export function keep() {}\n`,
    "gone.ts": `export function gone() {}\n`,
  })
  const svc = createIndexService({ root, forceMemory: true, now: makeClock() })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.status().fileCount, 2)
    await fsp.rm(path.join(root, "gone.ts"))
    await svc.syncStale()
    assert.equal(svc.status().fileCount, 1)
    assert.equal(svc.search("gone").length, 0)
  } finally {
    svc.dispose()
  }
})

test("persists to a real .cognia/codegraph.db across service instances (sqlite)", async () => {
  const root = await tmpRepo({ "x.ts": `export function persisted() {}\n` })
  const svc1 = createIndexService({ root })
  await svc1.ensureIndexed()
  const binding = svc1.status().binding
  svc1.dispose()
  // The db file should exist when sqlite is the backend.
  if (binding === "sqlite") {
    assert.ok(fs.existsSync(path.join(root, ".cognia", "codegraph.db")))
    const svc2 = createIndexService({ root })
    await svc2.ensureIndexed()
    assert.ok(svc2.search("persisted").length >= 1)
    svc2.dispose()
  }
})

test("stalenessBanner is empty when current", async () => {
  const root = await tmpRepo({ "a.ts": `export function a() {}\n` })
  const svc = createIndexService({ root, forceMemory: true })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.stalenessBanner(), "")
  } finally {
    svc.dispose()
  }
})

/** Monotonic clock that always reports a time past the sync throttle. */
function makeClock() {
  let t = 0
  return () => {
    t += 5000
    return t
  }
}

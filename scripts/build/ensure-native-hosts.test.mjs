import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { NATIVE_HOSTS, isStale, plan, sourceMtimes } from "./ensure-native-hosts.mjs"

test("isStale: missing output, or any newer source, means stale", () => {
  assert.equal(isStale(undefined, [1, 2]), true)
  assert.equal(isStale(null, []), true)
  assert.equal(isStale(100, [50, 99, 100]), false)
  assert.equal(isStale(100, [50, 101]), true)
  assert.equal(isStale(100, []), false)
  // A build stamp newer than the sources proves a no-op cargo run already
  // considered them, even though cargo left the binary's mtime alone.
  assert.equal(isStale(100, [150], 200), false)
  assert.equal(isStale(100, [250], 200), true)
})

test("plan skips under COGNIA_SKIP_NATIVE_HOSTS=1 and names the two hosts otherwise", () => {
  assert.deepEqual(plan(process.cwd(), { COGNIA_SKIP_NATIVE_HOSTS: "1" }), { skipped: true, stale: [] })
  assert.deepEqual(
    NATIVE_HOSTS.map((h) => h.bin),
    ["cognia-external-agent-launcher", "cognia-task-workspace-worker"]
  )
})

test("sourceMtimes walks .rs and Cargo.toml and the workspace lock, skipping target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-hosts-"))
  const crate = path.join(dir, "crates/x")
  fs.mkdirSync(path.join(crate, "src"), { recursive: true })
  fs.mkdirSync(path.join(crate, "target"), { recursive: true })
  fs.writeFileSync(path.join(crate, "Cargo.toml"), "")
  fs.writeFileSync(path.join(crate, "src/lib.rs"), "")
  fs.writeFileSync(path.join(crate, "src/notes.md"), "")
  fs.writeFileSync(path.join(crate, "target/junk.rs"), "")
  fs.writeFileSync(path.join(dir, "Cargo.lock"), "")
  const mtimes = sourceMtimes({ dir: "crates/x" }, dir)
  assert.equal(mtimes.length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

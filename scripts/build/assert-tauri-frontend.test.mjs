import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const script = path.resolve("scripts/build/assert-tauri-frontend.mjs")

test("accepts normal output and rejects profiling-marked output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cognia-tauri-frontend-"))
  try {
    const accepted = spawnSync(process.execPath, [script, directory], { encoding: "utf8" })
    assert.equal(accepted.status, 0)
    await writeFile(path.join(directory, ".cognia-profile.json"), '{"profile":"profiling"}\n')
    const rejected = spawnSync(process.execPath, [script, directory], { encoding: "utf8" })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /rejected a profiling frontend/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

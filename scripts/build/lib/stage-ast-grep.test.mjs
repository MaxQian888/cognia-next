import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { stageAstGrep } from "./stage-ast-grep.mjs"

test("stages an executable AST search binary for a clean CLI layout", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-stage-sg-"))
  try {
    const binary = stageAstGrep({ outDir })
    assert.equal(path.dirname(binary), path.join(outDir, "sidecar"))
    const result = spawnSync(binary, ["--version"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ast-grep/)
    assert.throws(() => stageAstGrep({ outDir, platform: "unsupported", arch: "unknown" }), /matching @ast-grep/)
  } finally { await fs.rm(outDir, { recursive: true, force: true }) }
})

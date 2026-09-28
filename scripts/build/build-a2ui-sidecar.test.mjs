import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("A2UI bundle runs outside the repository without dependencies and drains stdin", () => {
  const built = spawnSync(process.execPath, ["scripts/build/build-a2ui-sidecar.mjs"], { encoding: "utf8" })
  assert.equal(built.status, 0, built.stderr)
  const dir = mkdtempSync(join(tmpdir(), "cognia-a2ui-"))
  try {
    const entry = join(dir, "a2ui-mcp.mjs")
    copyFileSync("sidecar/a2ui-mcp.mjs", entry)
    const result = spawnSync(process.execPath, [entry], {
      cwd: dir,
      env: { PATH: process.env.PATH },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a2ui_delete_surface", arguments: { surfaceId: "s" } } }) + "\n",
      encoding: "utf8",
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).id, 1)
    assert.equal(JSON.parse(JSON.parse(result.stdout).result.content[0].text).surfaceId, "s")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

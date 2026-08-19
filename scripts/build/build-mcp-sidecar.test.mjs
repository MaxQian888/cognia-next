import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const script = path.join(repoRoot, "scripts", "build", "build-mcp-sidecar.mjs")
const output = path.join(repoRoot, "sidecar", "cognia-mcp.mjs")

test("bundles the complete host-bridged MCP tool surface", () => {
  rmSync(output, { force: true })

  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[build-mcp-sidecar\] ok/)
})

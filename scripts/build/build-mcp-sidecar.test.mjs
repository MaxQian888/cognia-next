import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const script = path.join(repoRoot, "scripts", "build", "build-mcp-sidecar.mjs")
const output = path.join(repoRoot, "sidecar", "cognia-mcp.mjs")

test("bundles the complete host-bridged MCP tool surface", async () => {
  rmSync(output, { force: true })

  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[build-mcp-sidecar\] ok/)

  const source = readFileSync(output, "utf8")
  for (const forbidden of [
    "lib/support-agent/support-docs.generated.json",
    "elk.bundled.js",
    "i18n/messages/zh-CN.json",
    "plugins/cognia-pdf/src/index.ts",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replaceAll(".", "\\.")))
  }

  const syntax = spawnSync(process.execPath, ["--check", output], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`)

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string")
  )
  env.COGNIA_BRIDGED = "1"
  env.COGNIA_BRIDGE_SETTINGS = JSON.stringify({
    enabled: true,
    enabledScopes: ["agent:dispatch"],
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [output],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  })
  const client = new Client({ name: "mcp-sidecar-build-smoke", version: "1.0.0" })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const names = new Set(tools.tools.map((tool) => tool.name))
    for (const expected of [
      "spawn_task",
      "schedule_task",
      "list_scheduled_tasks",
      "cancel_scheduled_task",
    ]) {
      assert.equal(names.has(expected), true, `missing MCP tool: ${expected}`)
    }
  } finally {
    await client.close()
  }
})

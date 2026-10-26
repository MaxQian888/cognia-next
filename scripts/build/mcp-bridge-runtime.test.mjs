import assert from "node:assert/strict"
import { test } from "node:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const runtimeEntry = path.join(repoRoot, "scripts", "build", "mcp-bridge-runtime.ts")

async function loadRuntimeWithProxyProbe() {
  const result = await esbuild.build({
    entryPoints: [runtimeEntry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    write: false,
    plugins: [
      {
        name: "mcp-proxy-probe",
        setup(build) {
          build.onResolve(
            { filter: /^@\/lib\/external-bridge\/orchestration-proxy-client$/ },
            () => ({ path: "proxy-probe", namespace: "mcp-proxy-probe" })
          )
          build.onLoad({ filter: /.*/, namespace: "mcp-proxy-probe" }, () => ({
            contents: `
              export async function proxyToHost(command, input) {
                globalThis.__mcpProxyCalls.push({ channel: "host", command, input })
                return globalThis.__mcpProxyResult
              }
              export async function proxyToRenderer(command, input) {
                globalThis.__mcpProxyCalls.push({ channel: "renderer", command, input })
                return globalThis.__mcpProxyResult
              }
            `,
            loader: "js",
          }))
        },
      },
    ],
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64")
  return import(`data:text/javascript;base64,${source}#${Date.now()}`)
}

test("renderer-owned task wrappers preserve command, payload, and failure envelopes", async () => {
  globalThis.__mcpProxyCalls = []
  globalThis.__mcpProxyResult = { ok: false, error: "desktop renderer unavailable" }
  const runtime = await loadRuntimeWithProxyProbe()

  const calls = [
    [runtime.scheduleTask, "schedule_task", { sessionId: "s1", prompt: "run", intervalMs: 60_000 }],
    [runtime.listScheduledTasks, "list_scheduled_tasks", { sessionId: "s1" }],
    [runtime.cancelScheduledTask, "cancel_scheduled_task", { sessionId: "s1", taskId: "t1" }],
    [runtime.spawnTask, "spawn_task", { parentSessionId: "s1", title: "Investigate" }],
    [runtime.browserTool, "browser_tool", { clientId: "c1", toolName: "browser_snapshot" }],
    [runtime.workspaceTool, "workspace_tool", { clientId: "c1", tool: "workspace_roots", args: {} }],
  ]

  for (const [wrapper, command, input] of calls) {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await wrapper(input), globalThis.__mcpProxyResult)
    })
    assert.deepEqual(globalThis.__mcpProxyCalls.at(-1), {
      channel: "renderer",
      command,
      input,
    })
  }

  delete globalThis.__mcpProxyCalls
  delete globalThis.__mcpProxyResult
})

test("usage and tracker wrappers forward their arguments to the host", async () => {
  globalThis.__mcpProxyCalls = []
  globalThis.__mcpProxyResult = { ok: true, items: [] }
  const runtime = await loadRuntimeWithProxyProbe()
  try {
    for (const command of [
      "usageQuery", "sessionHealth", "optimizationFindings",
      "issuesList", "issuesGet", "issuesCreate", "issuesUpdate", "issuesComment",
    ]) {
      const input = { ref: "TASK-1", period: "7d" }
      assert.deepEqual(await runtime[command](input), globalThis.__mcpProxyResult)
      assert.deepEqual(globalThis.__mcpProxyCalls.at(-1), {
        channel: "host", command, input: { arguments: [input] },
      })
    }
  } finally {
    delete globalThis.__mcpProxyCalls
    delete globalThis.__mcpProxyResult
  }
})

// The host bridge plugin points every import of these modules at this shim
// (scripts/build/lib/mcp-host-bridge.mjs), so a value import the shim does not
// export breaks the sidecar and CLI bundles at build time.
const BRIDGED_DB_MODULES = ["@/lib/db/skills", "@/lib/db/characters", "@/lib/db/wiki-articles"]

function valueImports(source, specifier) {
  const names = []
  const pattern = new RegExp(
    String.raw`import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']` +
      specifier.replaceAll("/", "\\/") +
      `["']`,
    "g"
  )
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue
    for (const raw of match[2].split(",")) {
      const name = raw.trim()
      if (!name || name.startsWith("type ")) continue
      names.push(name.split(/\s+as\s+/)[0].trim())
    }
  }
  return names
}

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|stories)\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

test("the shim exports every value lib/ and sidecar/ import from a bridged db module", async () => {
  const runtime = await loadRuntimeWithProxyProbe()
  const missing = []
  for (const file of [...sourceFiles(path.join(repoRoot, "lib")), ...sourceFiles(path.join(repoRoot, "sidecar"))]) {
    const source = readFileSync(file, "utf8")
    if (!source.includes("@/lib/db/")) continue
    for (const specifier of BRIDGED_DB_MODULES) {
      for (const name of valueImports(source, specifier)) {
        if (typeof runtime[name] !== "function") {
          missing.push(`${name} (${specifier}, ${path.relative(repoRoot, file)})`)
        }
      }
    }
  }
  assert.deepEqual(missing, [])
})

test("Prompt Center owner calls forward to the host", async () => {
  globalThis.__mcpProxyCalls = []
  globalThis.__mcpProxyResult = { ok: true }
  const runtime = await loadRuntimeWithProxyProbe()
  try {
    for (const command of [
      "listResolvedCharacters", "listCharacterVariants", "createCharacterVariant", "duplicateSkill",
    ]) {
      await runtime[command]("id-1")
      assert.deepEqual(globalThis.__mcpProxyCalls.at(-1), {
        channel: "host", command, input: { arguments: ["id-1"] },
      })
    }
  } finally {
    delete globalThis.__mcpProxyCalls
    delete globalThis.__mcpProxyResult
  }
})

import assert from "node:assert/strict"
import { test } from "node:test"
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

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  assertMcpSidecarGraph,
  createMcpHostBridgePlugin,
  writeCheckedMcpSidecarOutput,
} from "./mcp-host-bridge.mjs"

function resolveWith(plugin, path) {
  let resolver
  plugin.setup({
    onResolve(_options, callback) {
      resolver = callback
    },
  })
  return resolver({ path })
}

test("routes renderer-owned scheduling and task-spawn handlers to the host bridge", () => {
  const bridgeRuntime = "/repo/scripts/build/mcp-bridge-runtime.ts"
  const plugin = createMcpHostBridgePlugin(bridgeRuntime)

  assert.deepEqual(resolveWith(plugin, "../handlers/scheduling"), { path: bridgeRuntime })
  assert.deepEqual(resolveWith(plugin, "../handlers/spawn-task"), { path: bridgeRuntime })
  assert.equal(resolveWith(plugin, "../handlers/computer-use"), undefined)
})

test("rejects renderer-only modules that contribute to an MCP sidecar output", () => {
  const metafile = {
    outputs: {
      "sidecar/cognia-mcp.mjs": {
        inputs: {
          "lib/external-bridge/mcp-server/server.ts": { bytesInOutput: 100 },
          "/repo/components/a2ui/a2ui-surface.tsx": { bytesInOutput: 1 },
          "plugins/cognia-pdf/src/index.ts": { bytesInOutput: 1 },
          "i18n/messages/zh-CN.json": { bytesInOutput: 1 },
          "lib/support-agent/support-docs.generated.json": { bytesInOutput: 1 },
          "lib/scheduler/task-scheduler.ts": { bytesInOutput: 1 },
          "lib/tasks/spawn-task-dispatch.ts": { bytesInOutput: 1 },
        },
      },
    },
  }

  assert.throws(() => assertMcpSidecarGraph(metafile), (error) => {
    for (const expected of [
      "components/a2ui/a2ui-surface.tsx",
      "plugins/cognia-pdf/src/index.ts",
      "i18n/messages/zh-CN.json",
      "lib/support-agent/support-docs.generated.json",
      "lib/scheduler/task-scheduler.ts",
      "lib/tasks/spawn-task-dispatch.ts",
    ]) {
      assert.match(error.message, new RegExp(expected.replaceAll(".", "\\.")))
    }
    return true
  })
})

test("ignores forbidden modules that esbuild loaded but fully tree-shook", () => {
  const metafile = {
    outputs: {
      "sidecar/cognia-mcp.mjs": {
        inputs: {
          "lib/external-bridge/mcp-server/server.ts": { bytesInOutput: 100 },
          "plugins/cognia-pdf/src/index.ts": { bytesInOutput: 0 },
          "node_modules/prettier/plugins/estree.mjs": { bytesInOutput: 10 },
        },
      },
    },
  }

  assert.doesNotThrow(() => assertMcpSidecarGraph(metafile))
})

test("validates the graph before replacing an existing sidecar output", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cognia-mcp-bridge-"))
  const outfile = path.join(directory, "cognia-mcp.mjs")
  writeFileSync(outfile, "known-good")

  try {
    assert.throws(() =>
      writeCheckedMcpSidecarOutput(
        {
          metafile: {
            outputs: {
              [outfile]: {
                inputs: { "lib/scheduler/task-scheduler.ts": { bytesInOutput: 1 } },
              },
            },
          },
          outputFiles: [{ path: outfile, contents: Buffer.from("renderer-leak") }],
        },
        outfile
      )
    )
    assert.equal(readFileSync(outfile, "utf8"), "known-good")

    writeCheckedMcpSidecarOutput(
      {
        metafile: {
          outputs: {
            [outfile]: {
              inputs: { "lib/external-bridge/mcp-server/server.ts": { bytesInOutput: 10 } },
            },
          },
        },
        outputFiles: [{ path: outfile, contents: Buffer.from("checked-output") }],
      },
      outfile
    )
    assert.equal(readFileSync(outfile, "utf8"), "checked-output")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

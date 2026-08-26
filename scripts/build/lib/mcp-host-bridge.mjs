const HOST_BRIDGED_IMPORTS = new Set([
  "@/lib/db/wiki-articles",
  "@/lib/db/skills",
  "@/lib/db/characters",
  "../audit-log",
  "../handlers/orchestration",
  "../handlers/rag",
  "../handlers/runtime",
  "../handlers/wiki",
  "../handlers/connectors",
  "../handlers/inbound",
  "../handlers/memory",
  "../handlers/workflow",
  "../handlers/scheduling",
  "../handlers/spawn-task",
])

const FORBIDDEN_OUTPUT_INPUTS = [
  /(?:^|\/)components\//,
  /(?:^|\/)stores\//,
  /(?:^|\/)plugins\//,
  /(?:^|\/)i18n\/messages\/(?:en|zh-CN)\.json$/,
  /(?:^|\/)lib\/support-agent\//,
  /(?:^|\/)lib\/scheduler\/task-scheduler\.ts$/,
  /(?:^|\/)lib\/tasks\/spawn-task-dispatch\.ts$/,
  /(?:^|\/)lib\/plugin\/core\/(?:browser-builtin-registry|manager)\.ts$/,
  /(?:^|\/)lib\/plugin\/messaging\/hooks-system\.ts$/,
]

export function createMcpHostBridgePlugin(bridgeRuntime) {
  return {
    name: "cognia-mcp-host-bridge",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        HOST_BRIDGED_IMPORTS.has(args.path) ? { path: bridgeRuntime } : undefined
      )
    },
  }
}

/** Reject renderer-only modules that survived tree shaking into a sidecar output. */
export function assertMcpSidecarGraph(metafile) {
  const leaked = new Set()
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [inputPath, contribution] of Object.entries(output.inputs ?? {})) {
      if (!contribution || contribution.bytesInOutput <= 0) continue
      const normalizedPath = inputPath.replaceAll("\\", "/")
      if (/(?:^|\/)node_modules\//.test(normalizedPath)) continue
      if (FORBIDDEN_OUTPUT_INPUTS.some((pattern) => pattern.test(normalizedPath))) {
        leaked.add(normalizedPath)
      }
    }
  }

  if (leaked.size > 0) {
    throw new Error(
      `[mcp-host-bridge] renderer-only modules leaked into the MCP sidecar:\n${[...leaked]
        .map((path) => `- ${path}`)
        .join("\n")}`
    )
  }
}

/** Validate an in-memory esbuild result before atomically replacing the sidecar. */
export function writeCheckedMcpSidecarOutput(result, outfile) {
  assertMcpSidecarGraph(result.metafile)
  const output = result.outputFiles?.find((file) => file.path === outfile)
  if (!output) {
    throw new Error(`[mcp-host-bridge] esbuild did not produce ${outfile}`)
  }

  const temporaryOutfile = `${outfile}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryOutfile, output.contents)
    renameSync(temporaryOutfile, outfile)
  } finally {
    rmSync(temporaryOutfile, { force: true })
  }
}
import { renameSync, rmSync, writeFileSync } from "node:fs"

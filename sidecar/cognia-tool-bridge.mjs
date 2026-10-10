// @ts-check
import { isMainModule } from "./src/shared/main-module.ts"
import { runToolBridge } from "./src/mcp/servers/tool-bridge.ts"
export * from "./src/mcp/servers/tool-bridge.ts"
if (process.env.COGNIA_ROLE === "tool-bridge" || isMainModule(import.meta.url)) {
  runToolBridge().catch((error) => {
    process.stderr.write(`cognia-tool-bridge: fatal: ${error?.message ?? String(error)}\n`)
    process.exit(1)
  })
}

// @ts-check
import { pathToFileURL } from "node:url"
import { runToolBridge } from "./src/mcp/servers/tool-bridge.ts"
export * from "./src/mcp/servers/tool-bridge.ts"
if (
  process.env.COGNIA_ROLE === "tool-bridge" ||
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href
) {
  runToolBridge().catch((error) => {
    process.stderr.write(`cognia-tool-bridge: fatal: ${error?.message ?? String(error)}\n`)
    process.exit(1)
  })
}

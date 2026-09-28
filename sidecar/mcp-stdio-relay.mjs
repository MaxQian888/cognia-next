// @ts-check
import { pathToFileURL } from "node:url"
import { runMcpStdioRelay } from "./src/mcp/relay/index.ts"
export {
  decodeRelayConfig,
  createRemoteTransport,
  runMcpStdioRelay,
} from "./src/mcp/relay/index.ts"
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMcpStdioRelay().catch((error) => {
    process.stderr.write(`MCP relay failed: ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}

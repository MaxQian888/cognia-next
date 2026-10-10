// @ts-check
import { isMainModule } from "./src/shared/main-module.ts"
import { runMcpStdioRelay } from "./src/mcp/relay/index.ts"
export {
  decodeRelayConfig,
  createRemoteTransport,
  runMcpStdioRelay,
} from "./src/mcp/relay/index.ts"
if (isMainModule(import.meta.url)) {
  runMcpStdioRelay().catch((error) => {
    process.stderr.write(`MCP relay failed: ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}

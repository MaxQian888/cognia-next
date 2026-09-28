import { runA2uiStdio } from "../mcp/servers/a2ui-stdio.ts"

const server = runA2uiStdio()
process.stdin.once("end", () => {
  server.close()
  setImmediate(() => process.exit(0))
})

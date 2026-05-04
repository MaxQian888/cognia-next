/**
 * Stdio transport wrapper.
 *
 * Thin adapter around `StdioServerTransport` so the rest of our code only
 * imports from `lib/external-bridge/`. Lets the test suite swap in an
 * in-memory transport without dragging in the SDK's stdio implementation.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport()
}

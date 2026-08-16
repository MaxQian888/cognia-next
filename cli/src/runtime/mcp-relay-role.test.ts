/**
 * @jest-environment node
 */
import { pathToFileURL } from "node:url"

import { resolveMcpRelayScript, runMcpRelayRole } from "./mcp-relay-role"

describe("packaged MCP relay role", () => {
  it("prefers the explicit relay script and otherwise resolves beside the binary", () => {
    expect(resolveMcpRelayScript({ COGNIA_MCP_RELAY_SCRIPT: "/custom/relay.mjs" })).toBe(
      "/custom/relay.mjs"
    )
    expect(resolveMcpRelayScript({}, "/dist/cognia-agent", () => true)).toBe(
      "/dist/sidecar/mcp-stdio-relay.mjs"
    )
  })

  it("imports and starts the relay export", async () => {
    const runMcpStdioRelay = jest.fn().mockResolvedValue(undefined)
    const importer = jest.fn().mockResolvedValue({ runMcpStdioRelay })
    await runMcpRelayRole({
      resolveScript: () => "/dist/sidecar/mcp-stdio-relay.mjs",
      importer,
    })
    expect(importer).toHaveBeenCalledWith(pathToFileURL("/dist/sidecar/mcp-stdio-relay.mjs").href)
    expect(runMcpStdioRelay).toHaveBeenCalledTimes(1)
  })

  it("fails closed when the relay export is missing", async () => {
    await expect(
      runMcpRelayRole({ resolveScript: () => "/relay", importer: async () => ({}) })
    ).rejects.toThrow("does not export")
  })
})

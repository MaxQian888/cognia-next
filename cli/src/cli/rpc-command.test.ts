/**
 * Tests for the `cognia-agent rpc` command.
 */

import { rpcCommand } from "./rpc-command"
import type { ParsedArgs } from "./args"

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "rpc",
    positionals: [],
    flags: {},
    help: false,
    version: false,
    ...overrides,
  }
}

describe("rpcCommand", () => {
  it("prints help and exits 0 with --help", async () => {
    const lines: string[] = []
    const out = {
      write: (s: string) => {
        lines.push(s)
      },
      error: (_s: string) => {},
    }
    const code = await rpcCommand(makeArgs({ help: true }), { out })
    expect(code).toBe(0)
    expect(lines.join("")).toContain("JSON-RPC 2.0")
  })
})

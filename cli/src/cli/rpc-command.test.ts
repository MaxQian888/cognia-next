/**
 * Tests for the `cognia-agent rpc` command.
 */

import { rpcCommand } from "./rpc-command"
import type { ParsedArgs } from "./args"

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "rpc",
    positionals: [],
    rest: [],
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
      json: (_value: unknown) => {},
    }
    const code = await rpcCommand(makeArgs({ help: true }), { out })
    expect(code).toBe(0)
    expect(lines.join("")).toContain("JSON-RPC 2.0")
  })

  it("starts the RPC service with CLI model, provider, and backend overrides", async () => {
    const serve = jest.fn(async () => undefined)
    const createService = jest.fn(() => ({ close: jest.fn() }) as never)
    const createServer = jest.fn(() => ({ serve }) as never)
    const loadConfig = jest.fn(
      () =>
        ({
          model: "base-model",
          provider: "base-provider",
          agentBackend: "builtin",
        }) as never
    )

    const code = await rpcCommand(
      makeArgs({
        flags: {
          model: "sdk-model",
          provider: "sdk-provider",
          backend: "external-host",
        },
      }),
      { loadConfig, createService, createServer }
    )

    expect(code).toBe(0)
    expect(createService).toHaveBeenCalledWith({
      config: expect.objectContaining({
        model: "sdk-model",
        provider: "sdk-provider",
        agentBackend: "external-host",
      }),
      home: expect.any(String),
    })
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        service: createService.mock.results[0]!.value,
        hostVersion: expect.any(String),
        runtimeVersion: expect.any(String),
        instanceId: expect.any(String),
      })
    )
    expect(serve).toHaveBeenCalledTimes(1)
  })

  it("returns 1 and emits a structured diagnostic when startup fails", async () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true)
    const close = jest.fn(async () => undefined)
    const createService = jest.fn(() => ({ close }) as never)
    const createServer = jest.fn(
      () => ({ serve: jest.fn(async () => Promise.reject(new Error("startup failed"))) }) as never
    )

    try {
      await expect(
        rpcCommand(makeArgs(), {
          loadConfig: () => ({}) as never,
          createService,
          createServer,
        })
      ).resolves.toBe(1)
      expect(write).toHaveBeenCalledWith(expect.stringContaining('"message":"startup failed"'))
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      write.mockRestore()
    }
  })
})

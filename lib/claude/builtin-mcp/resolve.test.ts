import {
  COGNIA_BRIDGE_SOCKET_ENV,
  COGNIA_SIDECAR_DIR_TOKEN,
  resolveBuiltinMcpConfig,
  type BuiltinMcpResolveContext,
} from "./resolve"
import type { McpServer } from "@cognia/agent-config-types"
import { A2UI_BRIDGE_SERVER_ID, A2UI_BRIDGE_SERVER_NAME } from "@/lib/a2ui/mcp-tool-schemas"

const ctx: BuiltinMcpResolveContext = {
  sidecarDir: "C:\\app\\sidecar",
  socketPath: "\\\\.\\pipe\\cognia-next-a2ui-bridge",
}

function row(partial: Partial<McpServer>): McpServer {
  return {
    id: partial.id ?? "row",
    name: partial.name ?? "row",
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {},
    enabled: partial.enabled ?? false,
    appsEnabled: partial.appsEnabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("resolveBuiltinMcpConfig", () => {
  it("replaces the placeholder in command", () => {
    const out = resolveBuiltinMcpConfig(
      row({ config: { command: `${COGNIA_SIDECAR_DIR_TOKEN}/node` } }),
      ctx
    )
    expect(out.config.command).toBe("C:\\app\\sidecar/node")
  })

  it("replaces the placeholder in every args entry", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        config: {
          command: "node",
          args: [
            `${COGNIA_SIDECAR_DIR_TOKEN}/a2ui-mcp.mjs`,
            "--flag",
            `prefix:${COGNIA_SIDECAR_DIR_TOKEN}/x`,
          ],
        },
      }),
      ctx
    )
    expect(out.config.args).toEqual([
      "C:\\app\\sidecar/a2ui-mcp.mjs",
      "--flag",
      "prefix:C:\\app\\sidecar/x",
    ])
  })

  it("leaves non-string args entries untouched", () => {
    const args = [42, true, null, { foo: "bar" }]
    const out = resolveBuiltinMcpConfig(row({ config: { command: "node", args } }), ctx)
    // Identity: nothing to substitute, no env to inject — original returned.
    expect(out.config.args).toBe(args)
  })

  it("replaces the placeholder in env values and leaves non-string env values intact", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        config: {
          command: "node",
          env: {
            EXTRA: `${COGNIA_SIDECAR_DIR_TOKEN}/lib`,
            COUNT: 3,
            FLAG: true,
          },
        },
      }),
      ctx
    )
    expect((out.config.env as Record<string, unknown>).EXTRA).toBe("C:\\app\\sidecar/lib")
    expect((out.config.env as Record<string, unknown>).COUNT).toBe(3)
    expect((out.config.env as Record<string, unknown>).FLAG).toBe(true)
  })

  it("injects COGNIA_BRIDGE_SOCKET only on the a2ui-bridge row (by id)", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        id: A2UI_BRIDGE_SERVER_ID,
        name: A2UI_BRIDGE_SERVER_NAME,
        config: {
          command: "node",
          args: [`${COGNIA_SIDECAR_DIR_TOKEN}/a2ui-mcp.mjs`],
        },
      }),
      ctx
    )
    expect((out.config.env as Record<string, unknown>)[COGNIA_BRIDGE_SOCKET_ENV]).toBe(
      ctx.socketPath
    )
  })

  it("recognises the bridge row by name even when the id differs", () => {
    const out = resolveBuiltinMcpConfig(
      row({ id: "anything", name: A2UI_BRIDGE_SERVER_NAME, config: { command: "node" } }),
      ctx
    )
    expect((out.config.env as Record<string, unknown>)[COGNIA_BRIDGE_SOCKET_ENV]).toBe(
      ctx.socketPath
    )
  })

  it("preserves existing env entries when injecting the socket", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        name: A2UI_BRIDGE_SERVER_NAME,
        config: { command: "node", env: { FOO: "bar" } },
      }),
      ctx
    )
    const env = out.config.env as Record<string, unknown>
    expect(env.FOO).toBe("bar")
    expect(env[COGNIA_BRIDGE_SOCKET_ENV]).toBe(ctx.socketPath)
  })

  it("does NOT inject the socket on non-bridge rows even when env is missing", () => {
    const out = resolveBuiltinMcpConfig(row({ name: "fs", config: { command: "node" } }), ctx)
    expect(out.config.env).toBeUndefined()
  })

  it("returns the input by reference when nothing needs changing", () => {
    const r = row({ name: "fs", config: { command: "node", args: ["server.js"] } })
    const out = resolveBuiltinMcpConfig(r, ctx)
    expect(out).toBe(r)
  })

  it("does not mutate the input", () => {
    const inputConfig = {
      command: `${COGNIA_SIDECAR_DIR_TOKEN}/node`,
      args: [`${COGNIA_SIDECAR_DIR_TOKEN}/a.mjs`],
      env: { X: `${COGNIA_SIDECAR_DIR_TOKEN}/y` },
    }
    const r = row({ name: A2UI_BRIDGE_SERVER_NAME, config: inputConfig })
    const out = resolveBuiltinMcpConfig(r, ctx)
    expect(inputConfig.command).toBe(`${COGNIA_SIDECAR_DIR_TOKEN}/node`)
    expect(inputConfig.args).toEqual([`${COGNIA_SIDECAR_DIR_TOKEN}/a.mjs`])
    expect(inputConfig.env).toEqual({ X: `${COGNIA_SIDECAR_DIR_TOKEN}/y` })
    expect(out.config).not.toBe(inputConfig)
  })

  it("re-substitutes when the same placeholder occurs multiple times in one string", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        config: {
          command: `${COGNIA_SIDECAR_DIR_TOKEN}/a:${COGNIA_SIDECAR_DIR_TOKEN}/b`,
        },
      }),
      ctx
    )
    expect(out.config.command).toBe("C:\\app\\sidecar/a:C:\\app\\sidecar/b")
  })

  it("treats a missing config object as identity", () => {
    const r = row({ name: "fs", config: undefined as unknown as Record<string, unknown> })
    const out = resolveBuiltinMcpConfig(r, ctx)
    expect(out).toBe(r)
  })

  it("does not re-inject the socket env when it already matches", () => {
    const r = row({
      name: A2UI_BRIDGE_SERVER_NAME,
      config: {
        command: "node",
        env: { [COGNIA_BRIDGE_SOCKET_ENV]: ctx.socketPath },
      },
    })
    const out = resolveBuiltinMcpConfig(r, ctx)
    expect(out).toBe(r)
  })

  it("overwrites an existing but stale socket env", () => {
    const out = resolveBuiltinMcpConfig(
      row({
        name: A2UI_BRIDGE_SERVER_NAME,
        config: {
          command: "node",
          env: { [COGNIA_BRIDGE_SOCKET_ENV]: "/tmp/old" },
        },
      }),
      ctx
    )
    const env = out.config.env as Record<string, unknown>
    expect(env[COGNIA_BRIDGE_SOCKET_ENV]).toBe(ctx.socketPath)
  })
})

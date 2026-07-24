/**
 * @jest-environment node
 */
import type { McpServer, SendOptions } from "@cognia/agent-config-types"

import { contextVersionProjection, hashContextVersion } from "./context-version"

const BASE_OPTIONS = {
  systemPrompt: "You are Cognia.",
  model: "claude-x",
  provider: "anthropic",
  permissionMode: "default",
  allowedTools: ["read", "write"],
  disallowedTools: ["bash"],
  builtinTools: { git: true, process: false, fileExtras: true },
  pluginTools: [{ name: "ask_user" }, { name: "dispatch_agent" }],
  confinement: { enabled: true, roots: ["/work", "/tmp/extra"] },
} as unknown as SendOptions

const mcp = (name: string, overrides: Partial<McpServer> = {}): McpServer =>
  ({ name, enabled: true, command: "srv", args: ["--x"], ...overrides }) as unknown as McpServer

function input(overrides: Partial<Parameters<typeof hashContextVersion>[0]> = {}) {
  return {
    sendOptions: BASE_OPTIONS,
    cwd: "/work",
    additionalDirectories: ["/work/pkg-a", "/work/pkg-b"],
    mcpServers: [mcp("alpha"), mcp("beta")],
    ...overrides,
  }
}

describe("contextVersionProjection", () => {
  it("keeps only semantic fields and sorts every set-like list", () => {
    const projection = contextVersionProjection(
      input({
        sendOptions: {
          ...BASE_OPTIONS,
          allowedTools: ["write", "read"],
          disallowedTools: ["bash"],
        } as SendOptions,
        additionalDirectories: ["/work/pkg-b", "/work/pkg-a"],
        mcpServers: [mcp("beta"), mcp("alpha")],
      })
    )
    expect(projection.allowedTools).toEqual(["read", "write"])
    expect(projection.additionalDirectories).toEqual(["/work/pkg-a", "/work/pkg-b"])
    expect(projection.builtinCategories).toEqual(["fileExtras", "git"])
    expect(projection.pluginTools).toEqual(["ask_user", "dispatch_agent"])
    const sep = String.fromCharCode(31)
    const servers = (projection.mcpServers as string[]).map((row) => row.split(sep))
    expect(servers.map((f) => f[0])).toEqual(["alpha", "beta"])
    expect(servers[0].slice(1)).toEqual(["on", "", "srv", "--x", ""])
  })

  it("never carries credentials from the send options", () => {
    const projection = contextVersionProjection(
      input({
        sendOptions: {
          ...BASE_OPTIONS,
          providerCredentials: { anthropic: { apiKey: "sk-secret" } },
          env: { ANTHROPIC_API_KEY: "sk-secret" },
        } as unknown as SendOptions,
      })
    )
    expect(JSON.stringify(projection)).not.toContain("sk-secret")
  })

  it("represents a missing confinement policy as null rather than omitting it", () => {
    const { confinement, ...rest } = BASE_OPTIONS as Record<string, unknown>
    void confinement
    expect(
      contextVersionProjection(input({ sendOptions: rest as SendOptions })).confinement
    ).toBeNull()
  })
})

describe("hashContextVersion", () => {
  it("is stable across re-resolves of the same context (order-insensitive)", () => {
    const a = hashContextVersion(input())
    const b = hashContextVersion(
      input({
        additionalDirectories: ["/work/pkg-b", "/work/pkg-a"],
        mcpServers: [mcp("beta"), mcp("alpha")],
      })
    )
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it.each([
    ["system prompt", { sendOptions: { ...BASE_OPTIONS, systemPrompt: "different" } }],
    ["model", { sendOptions: { ...BASE_OPTIONS, model: "gpt-x" } }],
    ["permission mode", { sendOptions: { ...BASE_OPTIONS, permissionMode: "plan" } }],
    ["builtin category toggle", { sendOptions: { ...BASE_OPTIONS, builtinTools: { git: false } } }],
    ["plugin manifest", { sendOptions: { ...BASE_OPTIONS, pluginTools: [{ name: "ask_user" }] } }],
    ["cwd", { cwd: "/elsewhere" }],
    ["additional roots", { additionalDirectories: ["/work/pkg-a"] }],
    ["mcp selection", { mcpServers: [mcp("alpha")] }],
    ["mcp disable overlay", { mcpServers: [mcp("alpha", { enabled: false }), mcp("beta")] }],
  ])("changes when the %s changes", (_label, overrides) => {
    expect(hashContextVersion(input(overrides as never))).not.toBe(hashContextVersion(input()))
  })

  it("ignores per-turn transport knobs that do not change what the session means", () => {
    const withKnobs = hashContextVersion(
      input({
        sendOptions: {
          ...BASE_OPTIONS,
          aiSdkMaxSteps: 512,
          toolExecutionTimeoutMs: 1000,
        } as unknown as SendOptions,
      })
    )
    expect(withKnobs).toBe(hashContextVersion(input()))
  })
})

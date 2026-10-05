import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import {
  duplicateDroppedEnvKeys,
  externalAgentDuplicateInput,
  uniqueDuplicateName,
} from "./duplicate-config"

const source: ExternalAgentConfig = {
  id: "agent-1",
  name: "Codex (read-only)",
  description: "Reviews without writing",
  protocol: "acp",
  transport: "stdio",
  enabled: false,
  cogniaModel: { providerId: "openai", modelId: "gpt-5.6" },
  process: { command: "codex", args: ["app-server"], env: { LOG: "1" } },
  defaultPermissionMode: "plan",
  autoApprovePatterns: ["Read*"],
  requireApprovalFor: ["Bash"],
  codexOptions: { sandboxMode: "readOnly", writableRoots: ["/repo"] },
  timeout: 90_000,
  retryConfig: {
    maxRetries: 1,
    retryDelay: 10,
    exponentialBackoff: false,
    maxRetryDelay: 10,
    retryOnErrors: [],
  },
  tags: ["review"],
  metadata: { preset: "codex" },
  declaredCapabilities: { mcp: "full" },
  capabilities: { loadSession: true },
  validitySnapshot: { executable: true, checkedAt: new Date(0), source: "probe" },
  registryProvenance: { registryId: "r", agentId: "codex", version: "1" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as ExternalAgentConfig

describe("externalAgentDuplicateInput", () => {
  it("copies every configured setting under the new name", () => {
    expect(externalAgentDuplicateInput(source, "Codex (read-only) copy")).toEqual({
      name: "Codex (read-only) copy",
      // A copy keeps its own runtime state and starts as switched off as its
      // source was; it records where it came from.
      stateIsolation: "isolated",
      enabled: false,
      duplicatedFromAgentId: "agent-1",
      description: "Reviews without writing",
      protocol: "acp",
      transport: "stdio",
      cogniaModel: { providerId: "openai", modelId: "gpt-5.6" },
      process: { command: "codex", args: ["app-server"], env: { LOG: "1" } },
      defaultPermissionMode: "plan",
      autoApprovePatterns: ["Read*"],
      requireApprovalFor: ["Bash"],
      codexOptions: { sandboxMode: "readOnly", writableRoots: ["/repo"] },
      timeout: 90_000,
      retryConfig: source.retryConfig,
      tags: ["review"],
      metadata: { preset: "codex" },
      declaredCapabilities: { mcp: "full" },
    })
  })

  it("leaves observed state, identity and timestamps behind", () => {
    const input = externalAgentDuplicateInput(source, "copy") as unknown as Record<string, unknown>
    for (const key of [
      "id",
      "capabilities",
      "validitySnapshot",
      "registryProvenance",
      "createdAt",
      "updatedAt",
    ]) {
      expect(input).not.toHaveProperty(key)
    }
  })

  it("deep-copies nested values so editing the copy never edits the source", () => {
    const input = externalAgentDuplicateInput(source, "copy")
    input.process?.args?.push("--extra")
    input.codexOptions?.writableRoots?.push("/other")
    expect(source.process?.args).toEqual(["app-server"])
    expect(source.codexOptions?.writableRoots).toEqual(["/repo"])
  })

  it("omits settings the source does not have", () => {
    const minimal = {
      id: "a",
      name: "n",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
    } as ExternalAgentConfig
    expect(externalAgentDuplicateInput(minimal, "n copy")).toEqual({
      name: "n copy",
      protocol: "acp",
      transport: "stdio",
      stateIsolation: "isolated",
      enabled: true,
      duplicatedFromAgentId: "a",
    })
  })

  it("honours the chosen isolation and enabled state", () => {
    expect(
      externalAgentDuplicateInput(source, { name: "c", stateIsolation: "shared", enabled: true })
    ).toMatchObject({ name: "c", stateIsolation: "shared", enabled: true })
  })

  it("carries the session settings and the account binding", () => {
    const input = externalAgentDuplicateInput(
      {
        ...source,
        maxConcurrentSessions: 2,
        sessionIdleTimeout: 5000,
        subscriptionAccountId: "acct-1",
      } as ExternalAgentConfig,
      "c"
    )
    expect(input).toMatchObject({
      maxConcurrentSessions: 2,
      sessionIdleTimeout: 5000,
      subscriptionAccountId: "acct-1",
    })
  })

  it("cuts what would make the copy share with its source", () => {
    const opencode = {
      ...source,
      process: {
        command: "opencode",
        args: ["serve"],
        env: { OPENCODE_CONFIG_DIR: "/a", XDG_DATA_HOME: "/b", LOG: "1" },
      },
      metadata: { preset: "opencode", port: 4096, serverPassword: "pw", createdByPluginId: "p" },
    } as unknown as ExternalAgentConfig
    const input = externalAgentDuplicateInput(opencode, "c")
    expect(input.process?.env).toEqual({ LOG: "1" })
    expect(input.metadata).toEqual({ preset: "opencode" })
    // The source is untouched.
    expect(opencode.process?.env?.OPENCODE_CONFIG_DIR).toBe("/a")
    expect(opencode.metadata?.port).toBe(4096)
    expect(duplicateDroppedEnvKeys(opencode)).toEqual(["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"])
    expect(duplicateDroppedEnvKeys(source)).toEqual([])
  })
})

describe("uniqueDuplicateName", () => {
  const label = (index: number) => (index === 1 ? "Codex (copy)" : `Codex (copy ${index})`)

  it("takes the bare copy name when it is free", () => {
    expect(uniqueDuplicateName(["Codex"], label)).toBe("Codex (copy)")
  })

  it("counts past names already taken, ignoring case and spacing", () => {
    expect(uniqueDuplicateName(["Codex", " codex (COPY) ", "Codex (copy 2)"], label)).toBe(
      "Codex (copy 3)"
    )
  })
})

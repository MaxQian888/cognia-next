import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { externalAgentDuplicateInput } from "./duplicate-config"

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
      "enabled",
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
    })
  })
})

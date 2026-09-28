import {
  DEFAULT_BUILTIN_TOOLS,
  type SendOptions as AppSendOptions,
} from "@cognia/agent-config-types"
import type { SendOptions as SidecarSendOptions } from "../../sidecar/src/shared/wire/inbound.ts"

// This assignment is checked by root tsc; the sidecar cannot import the app's hub.
const acceptsAppOptions = (options: AppSendOptions): SidecarSendOptions => options

test("the app send envelope remains assignable to the sidecar wire contract", () => {
  const options: AppSendOptions = {
    model: "fixture",
    provider: "anthropic",
    turnId: "wire-contract",
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS, coreFiles: true },
    lsp: { enabled: true, servers: [], autoInstall: false },
    mcpServers: { filesystem: { type: "stdio", command: "node", args: ["server.js"] } },
    modelParams: { temperature: 0.5, maxOutputTokens: 1024 },
    initialConversation: [{ role: "assistant", content: "saved" }],
    compaction: { enabled: true, contextWindow: 128000 },
    agents: {
      reviewer: {
        description: "Review a patch",
        prompt: "Review the proposed changes",
        permissionMode: "plan",
        provider: "anthropic",
        mcpServers: [
          "workspace",
          {
            search: {
              type: "http",
              url: "https://example.test/mcp",
              tools: [{ name: "search", permission_policy: "always_ask" }],
            },
          },
        ],
      },
    },
  }
  expect(acceptsAppOptions(options)).toBe(options)
})

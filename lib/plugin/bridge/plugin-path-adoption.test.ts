import { readFileSync } from "node:fs"
import { join } from "node:path"

const PATH_CONSUMING_BRIDGES = [
  "ai-providers-bridge.ts",
  "chat-middleware-bridge.ts",
  "config-component-bridge.ts",
  "context-panels-bridge.ts",
  "context-providers-bridge.ts",
  "deployment-filters-bridge.ts",
  "external-agent-adapters-bridge.ts",
  "message-renderer-bridge.ts",
  "modal-mount-bridge.ts",
  "ocr-providers-bridge.ts",
  "plugin-webview-bridge.ts",
  "protocol-adapters-bridge.ts",
  "routing-strategies-bridge.ts",
  "session-importers-bridge.ts",
  "terminal-completion-bridge.ts",
  "view-bridge.ts",
  "workspace-backend-bridge.ts",
] as const

describe("plugin path resolver adoption", () => {
  it.each(PATH_CONSUMING_BRIDGES)("routes every entry in %s through resolvePluginPath", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8")
    expect(source).toContain("resolvePluginPath")
    expect(source).not.toMatch(/`\$\{installRoot\}\/\$\{[^}]+\.entry\}`/)
  })
})
